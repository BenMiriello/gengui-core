declare module 'blocked-at' {
  interface BlockedAtOptions {
    threshold?: number;
  }

  type BlockedCallback = (time: number, stack: string[]) => void;

  function blocked(callback: BlockedCallback, options?: BlockedAtOptions): void;

  export default blocked;
}
