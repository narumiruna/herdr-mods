# Dependency notices

The mod's original source uses this repository's MIT license. Installed dependencies keep their own licenses. No dependency source or browser binary is vendored in this repository. Preserve package license/notice files when redistributing an installation.

| Direct runtime dependency | Pinned version | License      |
| ------------------------- | -------------- | ------------ |
| unified                   | 11.0.5         | MIT          |
| remark-parse              | 11.0.0         | MIT          |
| remark-gfm                | 4.0.1          | MIT          |
| remark-math               | 6.0.0          | MIT          |
| mdast-util-to-hast        | 13.2.1         | MIT          |
| hast-util-sanitize        | 5.0.2          | MIT          |
| hast-util-to-html         | 9.0.6          | MIT          |
| image-size                | 2.1.0          | MIT          |
| @xmldom/xmldom            | 0.9.12         | MIT          |
| mathjax-full              | 3.2.2          | Apache-2.0   |
| mermaid                   | 12.3.0         | MIT          |
| puppeteer                 | 25.17.0        | Apache-2.0   |
| vega                      | 6.4.0          | BSD-3-Clause |
| vega-lite                 | 6.5.0          | BSD-3-Clause |

Chromium is a separately installed browser with its own third-party notices. Its build is selected by the pinned Puppeteer package. Do not treat it as MIT-licensed mod source.

Mermaid's dependency tree also includes packages under other licenses, including ELK's EPL-2.0 terms. Consult each installed package's license before distributing dependencies or generated bundles. This table does not replace the complete dependency tree's notices.

The repository root and standalone mod package overrides pin transitive KaTeX to 0.19.1. It avoids the known trust-bypass advisory GHSA-238p-pmpm-9mq7 in the older version selected by the math parser. The native display-math path uses MathJax, not KaTeX's HTML/CSS output. Run `npm audit --omit=dev` after dependency changes.

`mathjax-full` 3.2.2 is deprecated upstream in favor of the version-4 package. This implementation pins the version-3 SVG API and fixed TeX package set; an upgrade needs renderer, sanitization, and native fixture checks.

Morsel was an architecture reference only. Its AGPL source was not copied into this MIT mod.
