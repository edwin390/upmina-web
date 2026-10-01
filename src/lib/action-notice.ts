// One short-lived success notice, outside the component that performed the mutation.
// Never contains server errors, credentials or upload URLs.
type Notice = { message: string } | null;
let notice: Notice = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function showActionSuccess(message: string) {
  if (timer) clearTimeout(timer);
  notice = { message };
  listeners.forEach((listener) => listener());
  timer = setTimeout(() => {
    notice = null;
    timer = undefined;
    listeners.forEach((listener) => listener());
  }, 6000);
}

export function subscribeActionNotice(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActionNotice() {
  return notice;
}
