// api/cleanup-files.js - ファイルクリーンアップ
export default async function cleanupHandler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { objectNames, driveFileIds } = req.body;
        
        const auth = new GoogleAuth({
            credentials: JSON.parse(
                Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8')
            ),
            scopes: [
                'https://www.googleapis.com/auth/cloud-platform',
                'https://www.googleapis.com/auth/drive'
            ]
        });

        const storage = new Storage({ auth });
        const bucketName = process.env.GOOGLE_STORAGE_BUCKET || 'speech-audio-files';
        const bucket = storage.bucket(bucketName);

        const results = {
            deletedCloudStorage: [],
            deletedDrive: [],
            errors: []
        };

        // Cloud Storageファイルの削除
        if (objectNames && objectNames.length > 0) {
            for (const objectName of objectNames) {
                try {
                    await bucket.file(objectName).delete();
                    results.deletedCloudStorage.push(objectName);
                } catch (error) {
                    results.errors.push(`Failed to delete ${objectName}: ${error.message}`);
                }
            }
        }

        // Google Driveファイルの削除（オプション）
        if (driveFileIds && driveFileIds.length > 0) {
            const authClient = await auth.getClient();
            const accessToken = await authClient.getAccessToken();

            for (const fileId of driveFileIds) {
                try {
                    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${accessToken.token}` }
                    });
                    results.deletedDrive.push(fileId);
                } catch (error) {
                    results.errors.push(`Failed to delete drive file ${fileId}: ${error.message}`);
                }
            }
        }

        res.status(200).json({
            success: true,
            results: results
        });

    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({ error: error.message });
    }
}
