import type { CalcResult } from "../../src/lib/calc.ts";

/** 計算不可を見逃さず、以降の期待値検証で成功時の型を使えるようにする。 */
export function calculated(result: CalcResult) {
  if (result.na) throw new Error(result.why);
  return result;
}
