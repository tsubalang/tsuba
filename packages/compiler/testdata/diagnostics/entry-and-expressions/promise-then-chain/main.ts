declare function f(): Promise<void>;

export function main(): void {
  f().then(() => {});
}
