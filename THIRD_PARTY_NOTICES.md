# Third-party notices

## lmfpd-sdk 0.2.0

`vendor/lmfpd-sdk/` is pinned from the npm SDK distribution committed in
[KaranocaVe/magpie-fingerprint](https://github.com/KaranocaVe/magpie-fingerprint/tree/48a510c39b9f695a896123f1017673d87abbfb80/vendor/lmfpd-sdk),
revision `48a510c39b9f695a896123f1017673d87abbfb80`. Its source is
[Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector), published from
`1e58ed83c1cde17f88cba89560ad4d083042ae92`.

The runtime has local changes: `decompress` is exported for bounded reference
downloads and consistency checks; number parsing preserves complete signed,
decimal and exponent tokens, and accepts only integer values in the challenge's
1–355 range. Streaming token boundaries and raw numeric diagnostics use the
same parsing rule. Negative numbers and decimal fragments are no longer treated
as valid positive integers. Reference loading also validates scoring parameter
shapes, dimensions and finite values, and runs a bounded scoring check before a
snapshot can be installed. Malformed optional calibration bindings yield no
confidence instead of throwing. Challenge generation, request templates and
ranking formulas are unchanged. The upstream SDK version remains 0.2.0. The original
runtime SHA-256 is `e8ad8d97eb8ed97cef084885e0e85274a7db28471c95dc1a46eda9919d4699f8`.

The gateway transport, queue, persistence and interface are implemented here.
No React, React DOM, icon package, or reference plugin service is bundled.

```text
MIT License

Copyright (c) 2026 xqy2006

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## fzstd 0.1.1

The vendored SDK contains this MIT-licensed decoder. Runtimes with a built-in
Zstandard decoder use a bounded output size; runtimes without that API use the
bundled decoder with a preallocated, bounded output buffer. Reference downloads
validate all frame headers and total declared output before decoding individual
frames, then verify the final detector digest. The decoder itself is unchanged.

```text
MIT License

Copyright (c) 2020 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Reference data

Data is downloaded separately from `https://lm.ikale.io/data/` or
`https://cdn.jsdmirror.com/npm/lmfpd-data@latest/`, or supplied through
`bankSource`. It is not distributed in the plugin archive. Each detection
records its snapshot and SDK version. A digest check verifies the detector
matches its downloaded manifest; it does not authenticate the publisher.
