// api/process-audio-chunk.js - チャンク処理
import { GoogleAuth } from 'google-auth-library';

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

    // リクエストボディの検証
    const { audioData, chunkIndex, startTime, config, clientId } = req.body;
    
    // 入力バリデーション
    const validation = validateChunkInput({ audioData, chunkIndex, config });
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid input',
        details: validation.errors,
        chunkIndex: chunkIndex
      });
    }

    // チャンクサイズ制限チェック（50MB）
    const audioSizeInMB = (audioData.length * 3) / 4 / 1024 / 1024;
    if (audioSizeInMB > 50) {
      return res.status(413).json({
        error: 'Audio chunk too large',
        maxSize: '50MB',
        currentSize: `${audioSizeInMB.toFixed(2)}MB`,
        chunkIndex: chunkIndex
      });
    }

    // サービスアカウント認証
    const serviceAccountInfo = JSON.parse(
      Buffer.from(serviceAccountKey, 'base64').toString('utf-8')
    );

    const auth = new GoogleAuth({
      credentials: serviceAccountInfo,
      projectId: projectId,
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/speech'
      ]
    });

    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();

    // チャンク処理用のSpeech-to-Text APIリクエスト構築
    const speechRequest = buildChunkSpeechRequest(audioData, config);

    // Google Speech-to-Text API呼び出し（短時間モデル使用）
    const speechResponse = await fetch(
      'https://speech.googleapis.com/v1/speech:recognize',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'speech-to-text-chunk-processor/1.0'
        },
        body: JSON.stringify(speechRequest)
      }
    );

    const speechData = await speechResponse.json();

    if (!speechResponse.ok) {
      console.error(`Chunk ${chunkIndex} Speech API Error:`, speechData);
      return res.status(speechResponse.status).json({
        success: false,
        error: 'Speech API Error',
        message: speechData.error?.message || 'Unknown error',
        code: speechData.error?.code,
        chunkIndex: chunkIndex,
        startTime: startTime
      });
    }

    // テキスト抽出
    const transcript = speechData.results && speechData.results.length > 0 
      ? speechData.results.map(result => result.alternatives[0].transcript).join(' ')
      : '';

    // 信頼度計算
    const confidence = speechData.results && speechData.results.length > 0
      ? speechData.results.reduce((sum, result) => sum + (result.alternatives[0].confidence || 0), 0) / speechData.results.length
      : 0;

    // 単語レベルの詳細情報を取得（オプション）
    const wordDetails = extractWordDetails(speechData.results);

    // 使用量ログ
    logChunkUsage({
      clientId,
      chunkIndex,
      audioLength: audioSizeInMB,
      language: config.languageCode,
      startTime: startTime,
      transcript: transcript,
      confidence: confidence,
      timestamp: new Date().toISOString(),
      projectId
    });

    // 成功レスポンス
    res.status(200).json({
      success: true,
      transcript: transcript,
      chunkIndex: chunkIndex,
      startTime: startTime || 0,
      duration: estimateChunkDuration(audioSizeInMB),
      confidence: confidence,
      wordCount: transcript.split(' ').filter(word => word.length > 0).length,
      wordDetails: wordDetails,
      processingMode: 'chunk',
      requestId: generateRequestId()
    });

  } catch (error) {
    console.error(`Chunk ${req.body?.chunkIndex || 'unknown'} processing error:`, error);
    
    // エラーの種類に応じた適切なレスポンス
    if (error.message.includes('Google Cloud設定')) {
      return res.status(500).json({
        success: false,
        error: 'Server configuration error',
        message: 'Google Cloud settings are invalid',
        chunkIndex: req.body?.chunkIndex
      });
    }
    
    if (error.message.includes('Authentication')) {
      return res.status(401).json({
        success: false,
        error: 'Authentication failed',
        message: 'Failed to authenticate with Google Cloud',
        chunkIndex: req.body?.chunkIndex
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Chunk processing failed',
      chunkIndex: req.body?.chunkIndex || null,
      requestId: generateRequestId()
    });
  }
}

// チャンク入力の検証
function validateChunkInput({ audioData, chunkIndex, config }) {
  const errors = [];

  // 必須項目のチェック
  if (!audioData || typeof audioData !== 'string') {
    errors.push('audioData is required and must be a base64 string');
  }

  if (chunkIndex === undefined || chunkIndex === null || typeof chunkIndex !== 'number') {
    errors.push('chunkIndex is required and must be a number');
  }

  if (!config || typeof config !== 'object') {
    errors.push('config is required and must be an object');
  } else {
    // 設定項目の詳細チェック
    if (!config.languageCode) {
      errors.push('config.languageCode is required');
    }
    
    if (!config.encoding) {
      errors.push('config.encoding is required');
    }

    // サポートされているエンコーディングのチェック
    const supportedEncodings = ['MP3', 'LINEAR16', 'FLAC', 'MULAW', 'AMR', 'AMR_WB', 'OGG_OPUS', 'SPEEX_WITH_HEADER_BYTE', 'WEBM_OPUS'];
    if (config.encoding && !supportedEncodings.includes(config.encoding)) {
      errors.push(`Unsupported encoding: ${config.encoding}`);
    }

    // サンプルレートの妥当性チェック
    if (config.sampleRateHertz && (config.sampleRateHertz < 8000 || config.sampleRateHertz > 48000)) {
      errors.push('sampleRateHertz must be between 8000 and 48000');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// チャンク用のSpeech APIリクエスト構築
function buildChunkSpeechRequest(audioData, config) {
  const requestBody = {
    config: {
      encoding: config.encoding,
      sampleRateHertz: config.sampleRateHertz || 16000,
      languageCode: config.languageCode,
      model: 'latest_short', // チャンク処理では短時間モデルを使用
      useEnhanced: true,
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
      enableWordConfidence: true, // 単語レベルの信頼度を取得
      maxAlternatives: 1,
      profanityFilter: false
    },
    audio: {
      content: audioData
    }
  };

  // 音声の種類に応じた最適化
  if (config.audioChannelCount) {
    requestBody.config.audioChannelCount = config.audioChannelCount;
  }

  if (config.enableSeparateRecognitionPerChannel) {
    requestBody.config.enableSeparateRecognitionPerChannel = config.enableSeparateRecognitionPerChannel;
  }

  // チャンク処理では話者識別は無効化（処理時間短縮のため）
  // 必要に応じて有効化可能
  if (config.enableDiarization && config.enableDiarization === true) {
    requestBody.config.diarizationConfig = {
      enableSpeakerDiarization: true,
      minSpeakerCount: 1,
      maxSpeakerCount: 2 // チャンク処理では最大2人に制限
    };
  }

  return requestBody;
}

// 単語レベルの詳細情報を抽出
function extractWordDetails(results) {
  if (!results || results.length === 0) {
    return [];
  }

  const wordDetails = [];
  
  results.forEach((result, resultIndex) => {
    if (result.alternatives && result.alternatives[0] && result.alternatives[0].words) {
      result.alternatives[0].words.forEach(wordInfo => {
        wordDetails.push({
          word: wordInfo.word,
          startTime: parseFloat(wordInfo.startTime?.seconds || 0) + parseFloat(wordInfo.startTime?.nanos || 0) / 1000000000,
          endTime: parseFloat(wordInfo.endTime?.seconds || 0) + parseFloat(wordInfo.endTime?.nanos || 0) / 1000000000,
          confidence: wordInfo.confidence || 0,
          speakerTag: wordInfo.speakerTag || null
        });
      });
    }
  });

  return wordDetails;
}

// チャンクの推定再生時間を計算
function estimateChunkDuration(audioSizeInMB) {
  // 音声ファイルのビットレートから概算時間を計算
  // 平均的なビットレート: 128kbps
  const averageBitrateKbps = 128;
  const bytesPerSecond = (averageBitrateKbps * 1024) / 8;
  const audioSizeInBytes = audioSizeInMB * 1024 * 1024;
  
  return Math.round(audioSizeInBytes / bytesPerSecond);
}

// チャンク処理用ログ
function logChunkUsage(data) {
  const logData = {
    type: 'chunk_processing',
    chunkIndex: data.chunkIndex,
    clientId: data.clientId,
    audioLength: data.audioLength,
    language: data.language,
    startTime: data.startTime,
    transcriptLength: data.transcript.length,
    wordCount: data.transcript.split(' ').filter(w => w.length > 0).length,
    confidence: data.confidence,
    timestamp: data.timestamp,
    projectId: data.projectId
  };

  if (process.env.NODE_ENV === 'development') {
    console.log('Chunk Usage Log:', logData);
  }

  // プロダクション環境では適切なログサービスに送信
  // 例: Google Cloud Logging, Vercel Analytics, etc.
  if (process.env.NODE_ENV === 'production') {
    // sendToLoggingService(logData);
  }
}

// リクエストID生成
function generateRequestId() {
  return `chunk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ヘルスチェック用の簡易テスト関数
export function testChunkProcessing() {
  return {
    endpoint: '/api/process-audio-chunk',
    method: 'POST',
    description: 'Process audio chunks for large file streaming',
    requiredFields: ['audioData', 'chunkIndex', 'config'],
    optionalFields: ['startTime', 'clientId'],
    maxChunkSize: '50MB',
    supportedEncodings: ['MP3', 'LINEAR16', 'FLAC', 'WEBM_OPUS'],
    example: {
      audioData: 'base64_encoded_audio_chunk',
      chunkIndex: 0,
      startTime: 0,
      config: {
        encoding: 'MP3',
        sampleRateHertz: 16000,
        languageCode: 'ja-JP'
      },
      clientId: 'client_abc123'
    }
  };
}
