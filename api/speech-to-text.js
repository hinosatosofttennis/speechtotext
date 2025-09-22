// api/speech-to-text.js (大容量ファイル対応版)
import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';

export default async function handler(req, res) {
  // 許可されたオリジンリスト
  const allowedOrigins = [
    'https://hinosatosofttennis.github.io',  // 実際のGitHub Pagesドメインに変更
    'http://localhost:3000',           // ローカル開発用
    'https://localhost:3000'           // ローカル開発用（HTTPS）
  ];

  const origin = req.headers.origin;
  
  // CORS設定
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  // プリフライトリクエスト対応
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // POST以外は拒否
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      allowedMethods: ['POST', 'OPTIONS']
    });
  }

  try {
    // 環境変数の確認
    const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const projectId = process.env.GOOGLE_PROJECT_ID;
    
    if (!serviceAccountKey || !projectId) {
      throw new Error('Google Cloud設定が不正です');
    }

    // サービスアカウント認証情報をデコード
    const serviceAccountInfo = JSON.parse(
      Buffer.from(serviceAccountKey, 'base64').toString('utf-8')
    );

    // Google Auth クライアントの初期化
    const auth = new GoogleAuth({
      credentials: serviceAccountInfo,
      projectId: projectId,
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/speech'
      ]
    });

    // アクセストークンの取得
    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();

    // リクエストボディの検証
    const { audioData, config, clientId, processingMode } = req.body;
    
    // 大容量ファイル処理モードの判定
    if (processingMode === 'large_file_cloud_storage') {
      return await processLargeFileViaCloudStorage(req.body, auth, res);
    } else if (processingMode === 'chunk_processing') {
      return await processAudioChunk(req.body, accessToken.token, res);
    }

    // 従来の直接処理
    const validation = validateInput({ audioData, config });
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid input',
        details: validation.errors
      });
    }

    // 音声データのサイズ制限チェック（4MB）
    const audioSizeInMB = (audioData.length * 3) / 4 / 1024 / 1024;
    if (audioSizeInMB > 1000) {
      return res.status(413).json({
        error: 'Audio file too large for direct processing',
        maxSize: '1000MB',
        currentSize: `${audioSizeInMB.toFixed(2)}MB`,
        suggestion: 'Use large file processing mode'
      });
    }

    // Speech-to-Text APIリクエストの構築
    const speechRequestBody = buildSpeechRequest(audioData, config);

    // Google Speech-to-Text API呼び出し
    const speechResponse = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken.token}`,
          'User-Agent': 'speech-to-text-app/1.1'
        },
        body: JSON.stringify(speechRequestBody)
      }
    );

    const speechData = await speechResponse.json();

    if (!speechResponse.ok) {
      console.error('Speech API Error:', speechData);
      return res.status(speechResponse.status).json({
        error: 'Speech API Error',
        message: speechData.error?.message || 'Unknown error',
        code: speechData.error?.code
      });
    }

    // 結果の検証と処理
    if (!speechData.results || speechData.results.length === 0) {
      return res.status(200).json({
        success: true,
        results: [],
        message: 'No speech detected in audio',
        processingMode: 'direct'
      });
    }

    // 使用量ログ
    logUsage({
      clientId,
      audioLength: audioSizeInMB,
      language: config.languageCode,
      hasDiarization: !!config.diarizationConfig,
      processingMode: 'direct',
      timestamp: new Date().toISOString(),
      projectId
    });

    // 成功レスポンス
    res.status(200).json({
      success: true,
      results: speechData.results,
      totalBilledTime: speechData.totalBilledTime,
      requestId: generateRequestId(),
      processingMode: 'direct'
    });

  } catch (error) {
    console.error('Server Error:', error);
    
    // エラーの種類に応じた適切なレスポンス
    if (error.message.includes('Google Cloud設定')) {
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'Google Cloud settings are invalid'
      });
    }
    
    if (error.message.includes('Authentication')) {
      return res.status(401).json({
        error: 'Authentication failed',
        message: 'Failed to authenticate with Google Cloud'
      });
    }
    
    res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred',
      requestId: generateRequestId()
    });
  }
}

// 大容量ファイル処理（Cloud Storage経由）
async function processLargeFileViaCloudStorage(requestBody, auth, res) {
  try {
    const { audioUri, config, clientId } = requestBody;
    
    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();

    // Long Running Operation用のリクエスト構築
    const speechRequest = {
      config: {
        encoding: config.encoding || 'MP3',
        sampleRateHertz: config.sampleRateHertz || 16000,
        languageCode: config.languageCode || 'ja-JP',
        model: 'latest_long',
        useEnhanced: true,
        enableAutomaticPunctuation: true,
        enableWordTimeOffsets: true,
        maxAlternatives: 1
      },
      audio: {
        uri: audioUri
      }
    };

    // 話者識別設定
    if (config.diarizationConfig) {
      speechRequest.config.diarizationConfig = {
        enableSpeakerDiarization: true,
        minSpeakerCount: config.diarizationConfig.minSpeakerCount || 2,
        maxSpeakerCount: config.diarizationConfig.maxSpeakerCount || 6
      };
    }

    // Long Running Recognition を開始
    const operationResponse = await fetch(
      'https://speech.googleapis.com/v1/speech:longrunningrecognize',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
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
    const result = await pollLongRunningOperation(operationName, accessToken.token);
    
    // 使用量ログ
    logUsage({
      clientId,
      language: config.languageCode,
      hasDiarization: !!config.diarizationConfig,
      processingMode: 'cloud_storage',
      timestamp: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      results: result.results || [],
      operationName: operationName,
      processingMode: 'cloud_storage',
      requestId: generateRequestId()
    });

  } catch (error) {
    throw new Error(`Large file processing failed: ${error.message}`);
  }
}

// Long Running Operation のポーリング
async function pollLongRunningOperation(operationName, accessToken, maxAttempts = 120) {
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

      // 進行状況をログ出力
      if (data.metadata && data.metadata.progressPercent) {
        console.log(`Processing progress: ${data.metadata.progressPercent}%`);
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
  
  throw new Error('Long running operation timeout (10 minutes)');
}

// チャンク処理
async function processAudioChunk(requestBody, accessToken, res) {
  try {
    const { audioData, chunkIndex, startTime, config } = requestBody;
    
    const speechRequest = {
      config: {
        encoding: config.encoding || 'MP3',
        sampleRateHertz: config.sampleRateHertz || 16000,
        languageCode: config.languageCode || 'ja-JP',
        model: 'latest_short', // チャンク処理では短時間モデルを使用
        enableAutomaticPunctuation: true
      },
      audio: {
        content: audioData
      }
    };

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

    const transcript = data.results && data.results.length > 0 
      ? data.results.map(result => result.alternatives[0].transcript).join(' ')
      : '';

    res.status(200).json({
      success: true,
      transcript: transcript,
      chunkIndex: chunkIndex,
      startTime: startTime,
      processingMode: 'chunk',
      confidence: data.results && data.results[0] ? data.results[0].alternatives[0].confidence : 0
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      chunkIndex: requestBody.chunkIndex,
      processingMode: 'chunk'
    });
  }
}

// 入力バリデーション関数
function validateInput({ audioData, config }) {
  const errors = [];

  if (!audioData || typeof audioData !== 'string') {
    errors.push('audioData is required and must be a base64 string');
  }

  if (!config || typeof config !== 'object') {
    errors.push('config is required and must be an object');
  } else {
    if (!config.languageCode) {
      errors.push('config.languageCode is required');
    }
    if (!config.encoding) {
      errors.push('config.encoding is required');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// Speech APIリクエスト構築
function buildSpeechRequest(audioData, config) {
  const requestBody = {
    config: {
      encoding: config.encoding,
      sampleRateHertz: config.sampleRateHertz || 16000,
      languageCode: config.languageCode,
      model: 'latest_long',
      useEnhanced: true,
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
      maxAlternatives: 1,
      ...config
    },
    audio: {
      content: audioData
    }
  };

  // 話者識別設定
  if (config.diarizationConfig) {
    requestBody.config.diarizationConfig = {
      enableSpeakerDiarization: true,
      minSpeakerCount: config.diarizationConfig.minSpeakerCount || 2,
      maxSpeakerCount: config.diarizationConfig.maxSpeakerCount || 6
    };
  }

  return requestBody;
}

// 使用量ログ
function logUsage(data) {
  if (process.env.NODE_ENV === 'development') {
    console.log('Usage Log:', data);
  }
  // プロダクション環境では適切なログサービスに送信
  // 例: Google Cloud Logging, Vercel Analytics, etc.
}

// リクエストID生成
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
