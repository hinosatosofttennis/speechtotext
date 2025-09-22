// api/process-large-audio.js - 大容量音声処理
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { objectName, config } = req.body;
        
        // サービスアカウント認証
        const auth = new GoogleAuth({
            credentials: JSON.parse(
                Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8')
            ),
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const authClient = await auth.getClient();
        const accessToken = await authClient.getAccessToken();

        // Cloud StorageのGS URIを構築
        const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'speech-audio-files';
        const audioUri = `gs://${bucketName}/${objectName}`;

        // Speech-to-Text API用リクエスト構築
        const speechRequest = {
            config: {
                encoding: 'MP3', // ファイル形式に応じて調整
                sampleRateHertz: 16000,
                languageCode: config.languageCode || 'ja-JP',
                model: 'latest_long',
                useEnhanced: true,
                enableAutomaticPunctuation: true,
                enableWordTimeOffsets: true
            },
            audio: {
                uri: audioUri
            }
        };

        // 話者識別設定
        if (config.enableDiarization) {
            speechRequest.config.diarizationConfig = {
                enableSpeakerDiarization: true,
                minSpeakerCount: config.minSpeakers || 2,
                maxSpeakerCount: config.maxSpeakers || 6
            };
        }

        // 長時間音声の場合はLong Running Operation を使用
        const useLongRunning = await checkFileDuration(audioUri, authClient);
        
        if (useLongRunning) {
            return await processLongRunningOperation(speechRequest, accessToken.token, res);
        } else {
            return await processStandardOperation(speechRequest, accessToken.token, res);
        }

    } catch (error) {
        console.error('大容量音声処理エラー:', error);
        res.status(500).json({ error: error.message });
    }
}

// 長時間音声処理（非同期）
async function processLongRunningOperation(speechRequest, accessToken, res) {
    try {
        // Long Running Operation を開始
        const operationResponse = await fetch(
            'https://speech.googleapis.com/v1/speech:longrunningrecognize',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(speechRequest)
            }
        );

        const operationData = await operationResponse.json();
        
        if (!operationResponse.ok) {
            throw new Error(`Speech API Error: ${operationData.error?.message}`);
        }

        // オペレーション状態をポーリング
        const operationName = operationData.name;
        const result = await pollOperation(operationName, accessToken);
        
        res.status(200).json({
            success: true,
            results: result.results || [],
            operationType: 'long_running'
        });

    } catch (error) {
        throw new Error(`Long running operation failed: ${error.message}`);
    }
}

// 標準処理
async function processStandardOperation(speechRequest, accessToken, res) {
    try {
        const response = await fetch(
            'https://speech.googleapis.com/v1/speech:recognize',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(speechRequest)
            }
        );

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(`Speech API Error: ${data.error?.message}`);
        }

        res.status(200).json({
            success: true,
            results: data.results || [],
            operationType: 'standard'
        });

    } catch (error) {
        throw new Error(`Standard operation failed: ${error.message}`);
    }
}

// オペレーション状態をポーリング
async function pollOperation(operationName, accessToken, maxAttempts = 60) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const response = await fetch(
                `https://speech.googleapis.com/v1/operations/${operationName}`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                }
            );

            const data = await response.json();
            
            if (data.done) {
                if (data.error) {
                    throw new Error(`Operation error: ${data.error.message}`);
                }
                return data.response;
            }

            // 5秒待機してから再試行
            await new Promise(resolve => setTimeout(resolve, 5000));
            
        } catch (error) {
            if (attempt === maxAttempts - 1) {
                throw error;
            }
            // 一時的なエラーの場合は再試行
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    
    throw new Error('Operation timeout');
}

// ファイルの長さを確認（概算）
async function checkFileDuration(audioUri, authClient) {
    // ファイルサイズやメタデータから音声の長さを推定
    // 60秒を超える場合はlong running operationを使用
    try {
        const storage = new Storage({ auth: authClient });
        const [metadata] = await storage.bucket(audioUri.split('/')[2]).file(audioUri.split('/').slice(3).join('/')).getMetadata();
        
        // ファイルサイズから概算（目安: 1MB = 約1分）
        const estimatedDurationMinutes = metadata.size / (1024 * 1024);
        return estimatedDurationMinutes > 4; // 1分を超える場合はlong running
        
    } catch (error) {
        console.warn('Duration check failed, using long running as fallback');
        return true; // エラーの場合は安全にlong runningを使用
    }
}
