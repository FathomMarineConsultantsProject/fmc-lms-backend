import { S3Client } from "@aws-sdk/client-s3";

export const AWS_REGION = process.env.AWS_REGION || "eu-north-1";
export const S3_BUCKET = process.env.S3_BUCKET;
export const SIGNED_URL_EXPIRES = Number(process.env.SIGNED_URL_EXPIRES || 3600);

export const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});