import { privateJson } from '@/lib/api-auth';
import { storageUnavailableResponse } from '@/lib/auth-request';
import { getCurrentUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const user = await getCurrentUser();
    return privateJson({ user });
  } catch (error) {
    const storageResponse = storageUnavailableResponse(error);
    if (storageResponse) return storageResponse;
    throw error;
  }
}
