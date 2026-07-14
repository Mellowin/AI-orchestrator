export function mapExitCode(status: number): number {
  return status === 0 ? 0 : 1;
}
