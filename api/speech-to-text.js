// api/speech-to-text.js (サービスアカウント対応版)　
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
    const { audioData, config, clientId } = req.body;
    
    const validation = validateInput({ audioData, config });
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid input',
        details: validation.errors
      });
    }

    // 音声データのサイズ制限チェック（15MB）
    const audioSizeInMB = (audioData.length * 3) / 4 / 1024 / 1024;
    if (audioSizeInMB > 15) {
      return res.status(413).json({
        error: 'Audio file too large',
        maxSize: '15MB',
        currentSize: `${audioSizeInMB.toFixed(2)}MB`
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
          'User-Agent': 'speech-to-text-app/1.0'
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
        message: 'No speech detected in audio'
      });
    }

    // 使用量ログ
    logUsage({
      clientId,
      audioLength: audioSizeInMB,
      language: config.languageCode,
      hasDiarization: !!config.diarizationConfig,
      timestamp: new Date().toISOString(),
      projectId
    });

    // 成功レスポンス
    res.status(200).json({
      success: true,
      results: speechData.results,
      totalBilledTime: speechData.totalBilledTime,
      requestId: generateRequestId()
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

// Gemini API呼び出し用エンドポイント
export async function geminiHandler(req, res) {
  // CORS設定（同じロジック）
  const allowedOrigins = [
    'https://hinosatosofttennis.github.io',
    'http://localhost:3000',
    'https://localhost:3000'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Secret Managerからgemini APIキーを取得
    const auth = new GoogleAuth({
      credentials: JSON.parse(
        Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8')
      ),
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const authClient = await auth.getClient();
    const projectId = process.env.GOOGLE_PROJECT_ID;
    
    // Secret Manager APIでGemini APIキーを取得
    const secretResponse = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/gemini-api-key/versions/latest:access`,
      {
        headers: {
          'Authorization': `Bearer ${(await authClient.getAccessToken()).token}`
        }
      }
    );

    const secretData = await secretResponse.json();
    const geminiApiKey = Buffer.from(secretData.payload.data, 'base64').toString('utf-8');

    // Gemini API呼び出し
    const { text, options } = req.body;
    
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: text
            }]
          }],
          generationConfig: {
            temperature: options?.temperature || 0.7,
            maxOutputTokens: options?.maxOutputTokens || 2048
          }
        })
      }
    );

    const geminiData = await geminiResponse.json();

    if (!geminiResponse.ok) {
      throw new Error(`Gemini API Error: ${geminiData.error?.message}`);
    }

    res.status(200).json({
      success: true,
      result: geminiData.candidates[0].content.parts[0].text
    });

  } catch (error) {
    console.error('Gemini API Error:', error);
    res.status(500).json({
      error: 'Gemini API Error',
      message: error.message
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
}

// リクエストID生成
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
