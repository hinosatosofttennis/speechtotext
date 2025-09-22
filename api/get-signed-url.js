// api/get-signed-url.js - Cloud Storage署名付きURL生成
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { fileName, fileSize, contentType } = req.body;
        
        // サービスアカウント認証
        const auth = new GoogleAuth({
            credentials: JSON.parse(
                Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8')
            ),
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const storage = new Storage({
            auth: auth,
            projectId: process.env.GOOGLE_PROJECT_ID
        });

        const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'speech-audio-files';
        const bucket = storage.bucket(bucketName);
        
        // ユニークなオブジェクト名を生成
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substring(2, 15);
        const objectName = `audio/${timestamp}-${randomString}-${fileName}`;

        // 署名付きURLを生成（アップロード用）
        const [signedUrl] = await bucket.file(objectName).getSignedUrl({
            version: 'v4',
            action: 'write',
            expires: Date.now() + 15 * 60 * 1000, // 15分有効
            contentType: contentType
        });

        res.status(200).json({
            signedUrl: signedUrl,
            objectName: objectName,
            bucketName: bucketName
        });

    } catch (error) {
        console.error('署名付きURL生成エラー:', error);
        res.status(500).json({ error: 'Failed to generate signed URL' });
    }
}
