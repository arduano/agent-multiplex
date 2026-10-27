# Retained license inputs

These published archives omit their complete license file, so the build retains
the exact upstream license bytes without requiring a network fetch:

- `remark-math@6.0.0`: repository publication commit
  `d5d0660b150810a535bbb07eac6cc96a4510aa24`, root `license`.
- `rehype-katex@7.0.1`: repository publication commit
  `88a9497e1ede93b958237c85edbf5651faeca7af`, root `license`.

The companion generator records the exact source URLs. The module also retains
the omitted `react-remove-scroll-bar@2.3.8` license copied byte-for-byte from the
existing verified public dashboard input, with its original upstream locator.
Notice generation depends only on this module's retained inputs.

The standard SIL OFL 1.1 body is retained from the published Geist font license;
the generator supplies KaTeX's actual per-font copyright, Reserved Font Names and
license metadata read from its pinned, unmodified TTF name tables. The package's
MIT JavaScript license does not replace those font terms.
