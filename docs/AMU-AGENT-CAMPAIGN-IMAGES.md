# AMU agent lifestyle images

Five owner-selected AI-generated campaign scenes integrated into the redesign in PR #17.

- Café: hero image.
- Rooftop and conference lounge: supporting hero images.
- Creative studio and night workspace: agent lifestyle section.

The humanoid robots visually represent software agents. These are campaign illustrations, not member identities or documentary AMU event photos. Generated clothing wordmarks are concept depictions, not source logo files. The page discloses generated imagery and keeps authentic meetup photos in their own section.

The ten files live directly in `site/photos/` and carry the `amu-agent-` prefix, not a subdirectory. The module's photo route (`platform/community/lib/release.js`, `photoFile`) resolves a single flat directory and rejects any name containing a slash, so a `photos/agents/` subdirectory returns 404 in the local preview and anywhere the module serves the page; the prefix keeps generated scenes distinguishable from the authentic meetup photographs.

WebP derivatives at 640 and 1120 pixels use responsive sources, intrinsic dimensions and lazy loading except for the eager hero. Combined size of all ten assets: 708,030 bytes.

Validation: all five placements and ten source files checked, image decoding verified, alt text and dimensions present, disclosure verified, git diff checked. Production deployment requires applying the reviewed redesign on xenhive-amu (159.203.143.195); this workspace has no SSH credentials to that host. No service, database, env, DNS or nginx changes are included.
