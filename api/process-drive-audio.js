// api/process-drive-audio.js - Google Drive経由処理
export default async function driveAudioHandler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { driveFileId, config } = req.body;
        
        // サービスアカウント認証
        const auth = new GoogleAuth({
            credentials: JSON.parse(
                Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8')
            ),
            scopes: [
                'https://www.googleapis.com/auth/cloud-platform',
                'https://www.googleapis.com/auth/drive'
            ]
        });

        const authClient = await auth.getClient();
        const accessToken = await authClient.getAccessToken();

        // Google Driveファイルを一時的にCloud Storageにコピー
        const tempObjectName = await copyDriveFileToStorage(driveFileId, accessToken.token);
        
        // Speech-to-Text処理
        const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'speech-to-2025text';
        const audioUri = `gs://${bucketName}/${tempObjectName}`;
        
        const speechRequest = {
            config: {
                encoding: 'MP3',
                sampleRateHertz: 16000,
                languageCode: config.languageCode || 'ja-JP',
                model: 'latest_long',
                useEnhanced: true,
                enableAutomaticPunctuation: true
            },
            audio: {
                uri: audioUri
            }
        };

        if (config.enableDiarization) {
            speechRequest.config.diarizationConfig = {
                enableSpeakerDiarization: true,
                minSpeakerCount: 2,
                maxSpeakerCount: 6
            };
        }

        // 処理実行
        const result = await processLongRunningOperation(speechRequest, accessToken.token, res);
        
        // 一時ファイルを削除
        await cleanupTempFile(tempObjectName);
        
        return result;

    } catch (error) {
        console.error('Drive audio processing error:', error);
        res.status(500).json({ error: error.message });
    }
}

// DriveファイルをCloud Storageにコピー
async function copyDriveFileToStorage(driveFileId, accessToken) {
    // Drive APIでファイル情報を取得
    const fileInfoResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${driveFileId}`,
        {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        }
    );

    const fileInfo = await fileInfoResponse.json();
    
    // ファイルをダウンロード
    const fileDataResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
        {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        }
    );

    const fileData = await fileDataResponse.arrayBuffer();
    
    // Cloud Storageにアップロード
    const storage = new Storage();
    const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'speech-audio-files';
    const objectName = `temp/${Date.now()}-${fileInfo.name}`;
    
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectName);
    
    await file.save(Buffer.from(fileData), {
        metadata: {
            contentType: fileInfo.mimeType
        }
    });

    return objectName;
}

// 一時ファイルのクリーンアップ
async function cleanupTempFile(objectName) {
    try {
        const storage = new Storage();
        const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'speech-audio-files';
        await storage.bucket(bucketName).file(objectName).delete();
        console.log(`Temp file deleted: ${objectName}`);
    } catch (error) {
        console.warn(`Failed to delete temp file ${objectName}:`, error);
    }
}
