/** Local request binding, never sent as server authority or persisted. */
export interface PrivilegedSessionIdentity {
  userId: string | null;
  isActive: () => boolean;
}
