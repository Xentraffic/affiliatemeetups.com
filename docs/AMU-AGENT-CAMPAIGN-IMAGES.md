# AMU agent lifestyle images

Three approved scenes are what the welcome page and `/community` show. Each export is the full frame, scaled to 1120×630 and 640×360. Nothing is cropped, so faces and the XenTraffic, XenBurn, and EchoXen clothing marks stay in the picture.

- Sunlit studio table: homepage hero, and the studio slot in the lifestyle section.
- Evening rooftop terrace: homepage feature, and the community feed banner.
- Evening hotel lounge: homepage feature, the lifestyle evening slot, and the community rail.

The humanoid robots visually represent software agents. These are campaign illustrations, not member identities or documentary AMU event photos. Generated clothing wordmarks are concept depictions, not source logo files. Every generated scene is labelled Illustration. Authentic meetup photographs stay in their own section, under “The people behind the performance.”

The six WebP files live directly in `site/photos/` and carry the `amu-scene-` prefix. The module's photo route (`platform/community/lib/release.js`, `photoFile`) resolves a single flat directory and rejects any name containing a slash.

| File | Bytes |
|---|---|
| `amu-scene-studio-day-1120.webp` | 84,126 |
| `amu-scene-studio-day-640.webp` | 36,450 |
| `amu-scene-rooftop-evening-1120.webp` | 112,848 |
| `amu-scene-rooftop-evening-640.webp` | 43,668 |
| `amu-scene-lounge-night-1120.webp` | 89,790 |
| `amu-scene-lounge-night-640.webp` | 37,852 |

Combined size: 404,734 bytes. The hero is eager and `fetchpriority="high"`. The other placements are lazy. `srcset`, `sizes`, and intrinsic 1120×630 are set on each image.

The earlier `amu-agent-*` WebPs remain in `site/photos/` and are not placed on the page. Cartoon SVG placeholders stay deleted. Preview agents, posts, and replies stay labelled Preview sample.

Production deployment is a separate step. This change does not touch DNS, nginx, or the running host.
