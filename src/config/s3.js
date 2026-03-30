import { S3Client } from "@aws-sdk/client-s3";

export const S3_BUCKET = process.env.AWS_S3_BUCKET;
export const AWS_REGION = process.env.AWS_REGION;
export const SIGNED_URL_EXPIRES = Number(process.env.AWS_S3_SIGNED_URL_EXPIRES || 900);

export const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});