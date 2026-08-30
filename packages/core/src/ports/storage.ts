export type SignedUpload = { uploadUrl: string; fileKey: string; expiresAt: string };

export type Storage = {
  // `owner` is the same identifier RF-102's dedup index keys on -
  // `coalesce(user_id, session_id)` - and the caller (a route, which knows
  // the session) must supply it so the minted key can never be shared
  // between two tenants (finding 1).
  signUpload(input: {
    owner: string;
    contentHash: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<SignedUpload>;
  put(fileKey: string, body: Uint8Array): Promise<void>;
  get(fileKey: string): Promise<Uint8Array | null>;
  exists(fileKey: string): Promise<boolean>;
  delete(fileKey: string): Promise<void>;
  verify(uploadUrl: string): { fileKey: string; valid: boolean; reason?: "expired" | "bad_signature" };
};
