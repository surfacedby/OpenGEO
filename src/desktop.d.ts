export {};
declare global {
  interface Window {
    opengeoDesktop?: {
      setDraftProtectionPending: (value: boolean) => void;
      onQuitDeferred: (callback: () => void) => () => void;
    };
  }
}
