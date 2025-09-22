// api/get-google-token.js - Google OAuth2トークン取得
export default async function tokenHandler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // サービスアカウントを使用してGoogle APIアクセストークンを取得
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

        res.status(200).json({
            access_token: accessToken.token,
            expires_in: 3600,
            token_type: 'Bearer'
        });

    } catch (error) {
        console.error('Token generation error:', error);
        res.status(500).json({ error: 'Failed to generate token' });
    }
}
