// api/speech-to-text.js
export default async function handler(req, res) {
  // CORS設定
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', 'https://hinosatosofttennis.github.io'); // 実際のドメインに変更
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  // プリフライトリクエスト対応
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // POST以外は拒否
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { audioData, config, apiKey } = req.body;

    // バリデーション
    if (!audioData || !config || !apiKey) {
      return res.status(400).json({ 
        error: 'Missing required parameters: audioData, config, apiKey' 
      });
    }

    // Google Speech-to-Text APIに送信するリクエストボディ
    const requestBody = {
      config: {
        encoding: config.encoding || 'WEBM_OPUS',
        sampleRateHertz: config.sampleRateHertz || 16000,
        languageCode: config.languageCode || 'ja-JP',
        model: 'latest_long',
        useEnhanced: true,
        enableAutomaticPunctuation: true,
        enableWordTimeOffsets: true,
        ...config // 追加の設定をマージ
      },
      audio: {
        content: audioData
      }
    };

    // 話者識別設定がある場合
    if (config.diarizationConfig) {
      requestBody.config.diarizationConfig = config.diarizationConfig;
    }

    // Google Speech-to-Text API呼び出し
    const speechResponse = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    if (!speechResponse.ok) {
      const errorData = await speechResponse.json();
      console.error('Speech API Error:', errorData);
      return res.status(speechResponse.status).json({
        error: `Speech API Error: ${errorData.error?.message || 'Unknown error'}`,
        details: errorData
      });
    }

    const speechData = await speechResponse.json();

    // レスポンスの検証
    if (!speechData.results || speechData.results.length === 0) {
      return res.status(400).json({
        error: '音声からテキストを抽出できませんでした',
        details: speechData
      });
    }

    // 成功レスポンス
    res.status(200).json({
      success: true,
      results: speechData.results,
      totalBilledTime: speechData.totalBilledTime
    });

  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

// 使用例とテスト用エンドポイント
export function testEndpoint() {
  return {
    endpoint: '/api/speech-to-text',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: {
      audioData: 'base64_encoded_audio_data',
      config: {
        encoding: 'MP3',
        sampleRateHertz: 16000,
        languageCode: 'ja-JP',
        diarizationConfig: {
          enableSpeakerDiarization: true,
          minSpeakerCount: 2,
          maxSpeakerCount: 6
        }
      },
      apiKey: 'your_google_speech_api_key'
    }
  };
}
