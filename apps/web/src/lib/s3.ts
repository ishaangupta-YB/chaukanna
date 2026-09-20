import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config';

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) client = new S3Client({ region: config.region });
  return client;
}

export const PRESIGN_TTL_SECONDS = 300;

export async function presignPut(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: config.artifactsBucket, Key: key, ContentType: contentType }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );
}

/**
 * How long a debrief audio link lives. Long enough for a learner to find the play button, read
 * the page and press it — and short enough that a link copied out of a browser history is dead
 * by the time anyone else opens it. The bucket itself is private; this URL is the only way in.
 */
export const DEBRIEF_PRESIGN_TTL_SECONDS = 600;

/** A short lived link to one private object, for the browser to fetch directly. */
export async function presignGet(key: string, expiresIn = DEBRIEF_PRESIGN_TTL_SECONDS): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: config.artifactsBucket, Key: key }), {
    expiresIn,
  });
}

/** Size in bytes, or null when the object does not exist. */
export async function objectSize(key: string): Promise<number | null> {
  try {
    const out = await s3().send(new HeadObjectCommand({ Bucket: config.artifactsBucket, Key: key }));
    return out.ContentLength ?? 0;
  } catch (error) {
    if (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) return null;
    throw error;
  }
}
