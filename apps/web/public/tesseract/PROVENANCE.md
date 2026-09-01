# Tesseract 本站静态资产来源与版本

这些文件是 Tesseract.js 的公共运行资产（非用户内容），由本站同源分发，禁止运行时回退到 CDN。

| 文件 | 来源 | 版本 | 许可 |
|---|---|---|---|
| `worker.min.js` | npm `tesseract.js` 官方包 `dist/worker.min.js` | tesseract.js@7.0.0 | Apache-2.0 |
| `core/tesseract-core-{simd,relaxedsimd,}{-lstm}.wasm.js` | npm `tesseract.js-core` 官方包 | tesseract.js-core@7.0.0 | Apache-2.0（见 core/LICENSE） |
| `lang/eng.traineddata.gz` | jsdelivr `@tesseract.js-data/eng/4.0.0_best_int` | 4.0.0_best_int | Apache-2.0 |
| `lang/chi_sim.traineddata.gz` | jsdelivr `@tesseract.js-data/chi_sim/4.0.0_best_int` | 4.0.0_best_int | Apache-2.0 |

更新规则：升级 tesseract.js / core / 语言数据时，必须同步替换上述全部文件并更新本表版本；`apps/web/src/modules/tools/ocr-translate/` 中的 `workerPath`/`corePath`/`langPath` 固定指向 `/tesseract/...` 本站路径。
