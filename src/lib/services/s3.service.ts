import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export class S3Service {
  private static getClient() {
    const region = process.env.AWS_REGION || 'us-east-1';
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('Missing AWS credentials in environment variables.');
    }

    return new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  /**
   * Uploads a file buffer to AWS S3 and returns the public URL.
   */
  static async uploadAudio(
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string
  ): Promise<string> {
    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    const region = process.env.AWS_REGION || 'us-east-1';

    if (!bucketName) {
      throw new Error('Missing AWS_S3_BUCKET_NAME in environment variables.');
    }

    const s3Client = this.getClient();
    const key = `audios/${Date.now()}-${fileName}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
    });

    await s3Client.send(command);

    // Return standard public S3 URL
    return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
  }
}
