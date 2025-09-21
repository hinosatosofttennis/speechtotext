export default function handler(req, res) {
  if (req.method === 'GET') {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        speech: 'ready',
        gemini: 'ready'
      }
    });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}

# README.md (Vercel用)
# Speech-to-Text API Proxy

## 環境変数設定

Vercelダッシュボードで以下の環境変数を設定してください：

### 必須環境変数
- `GOOGLE_PROJECT_ID`: Google Cloud プロジェクトID
- `GOOGLE_SERVICE_ACCOUNT_KEY`: サービスアカウントキー（Base64エンコード）
- `GOOGLE_REGION`: Google Cloud リージョン

### 設定手順
1. Vercelダッシュボードにログイン
2. プロジェクト → Settings → Environment Variables
3. 上記の環境変数を追加

### デプロイ
```bash
vercel --prod
```

### API エンドポイント
- POST `/api/speech-to-text` - 音声テキスト変換
- POST `/api/gemini` - テキスト改善
- GET `/api/health` - ヘルスチェック

### セキュリティ
- サービスアカウント認証
- CORS制限
- レート制限
- 入力バリデーション
