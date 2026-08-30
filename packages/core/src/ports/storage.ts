export type SignedUpload = { uploadUrl: string; fileKey: string; expiresAt: string };

export type Storage = {
  signUpload(input: { contentHash: string; mimeType: string; sizeBytes: number }): Promise<SignedUpload>;
  put(fileKey: string, body: Uint8Array): Promise<void>;
  get(fileKey: string): Promise<Uint8Array | null>;
  exists(fileKey: string): Promise<boolean>;
  delete(fileKey: string): Promise<void>;
  verify(uploadUrl: string): { fileKey: string; valid: boolean; reason?: "expired" | "bad_signature" };
};
