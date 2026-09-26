/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ambient types for the OPTIONAL dedicated-MT runtime.
 *
 * `@huggingface/transformers` (transformers.js + ONNX Runtime for Node) is
 * deliberately NOT a dependency of this project: it is large, its native
 * postinstall step is blocked by npm's install-scripts policy on some setups,
 * and it is only needed when TRANSLATION_PROVIDER=local-mt-hf. It is imported
 * lazily and failure-tolerantly at runtime (see
 * src/server/services/translation/hfLocalMtProvider.ts, which reports
 * readiness=false when the package is absent, so translation silently keeps
 * using the configured fallback instead of breaking).
 *
 * This declaration only exists so `tsc --noEmit` type-checks the optional code
 * path without the package being installed. Install instructions live in
 * benchmarks/translation/README.md.
 */
declare module "@huggingface/transformers" {
  /** Runtime configuration (cache directory, remote host, ...). */
  export const env: Record<string, unknown>;
  /** Creates a task pipeline, for example pipeline("translation", model). */
  export function pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<any>;
}