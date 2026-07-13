# myFamiPedia — Web App Structure (Family Tree / Desktop View)

React (Vite) + React Router, same pattern as myMigo's parent dashboard. This is where the tree — "the canvas everything lives on" — gets its full interactive treatment; mobile's `tree.tsx` is a simplified read-mostly view of the same data.

```
src/
  main.tsx
  App.tsx                       # router root, auth guard
  routes/
    login.tsx                    # password or magic-link email sign-in — same /auth/* endpoints as mobile
    invite/[token].tsx          # public accept/decline landing (shares logic with mobile equivalent)
    tree/index.tsx              # primary canvas: pan/zoom graph, generational layout
    person/[id]/
      index.tsx                 # full profile: timeline + memories feed + connections, wide layout
      ask.tsx
      edit.tsx
    explore/
      person.tsx
      decade/[decade].tsx
    admin/
      moderation-queue.tsx
      deceased-profile/new.tsx
    settings/
      privacy.tsx
      voice.tsx
      notifications.tsx
      subscription.tsx           # family plan management, takeover flow
  components/
    tree/
      TreeCanvas.tsx             # d3-force or custom layout engine, SVG/Canvas render
      PersonNode.tsx
      RelationshipEdge.tsx
    profile/
      ProfileHeader.tsx
      LifeTimeline.tsx
      MemoriesFeed.tsx
      AskPanel.tsx
      ConnectionsPanel.tsx
    voice/
      ConsentFlowModal.tsx       # shares copy/logic with mobile consent screens
      AudioBadge.tsx             # real (teal) vs AI (gray) badge, waveform styling
    shared/
      MemoryCard.tsx
      ReactionBar.tsx
  hooks/
    useFamilyTree.ts
    useSearch.ts
    usePrivacyTier.ts
    useVoiceModel.ts
  lib/
    apiClient.ts                 # ideally imported from packages/shared (see mobile doc)
    queryClient.ts                # React Query setup, shared cache config with mobile where feasible
```

## Who can use the web app

**Decided:** the web app is a first-class client for every active family member, not an admin-only dashboard — any `persons` row with `status = 'active'` and a linked `users` row can log in (password or magic-link email, same `/auth/*` endpoints mobile uses) and get full read access to the tree, profiles, timelines, memories, search, and the Ask feature. This corrects the earlier framing below, which undersold that. It also resolves what was previously an open question: someone who never installs the mobile app can still fully participate as a viewer through the web — accepting an invitation and never downloading anything is a supported path, not a degraded fallback. `tenant_isolation` and the rest of the RLS policies (privacy doc) already scope by `family_group_id` and `current_person_id`, not by role, so no access-layer change was actually needed — this was a documentation gap, not a schema one.

Magic-link is worth defaulting to over password for this audience specifically: the user base skews toward relatives who may not want to manage or remember a password (the same reasoning behind keeping voice consent and privacy-tier controls low-friction elsewhere in the product), and a one-tap email link fits that better than a signup form.

## Why desktop still gets the primary tree *editing* surface

Universal viewing access doesn't change the UX allocation for authoring: the product doc frames the interactive tree as *the* canvas (section 1 intro), and administrator-heavy actions — building out relationships, initiating deceased profiles, moderation — are naturally mouse/keyboard tasks. Design assumption: desktop is where structural tree editing tends to happen; mobile is where memory contribution happens on the go. Both hit the same API and the same permission rules regardless of client, so this is a UX allocation, not an access gate — a family member could just as well add a relationship from mobile if the UI supported it, it's just a worse fit for a touch screen.

## Rendering approach for the tree

`d3-force` (or a custom generational-row layout, since family trees benefit from strict generation alignment that force-directed graphs don't guarantee) driving an SVG render, with virtualization for large trees (hundreds of nodes at scale). Recommend starting with a simple generational-row layout (compute generation depth via `relationships` BFS from a root person) rather than force simulation — more predictable, more "family tree"-looking, easier to keep stable across re-renders as data changes.

## Deploy

Static build (Vite) served behind the same Caddy instance as the API, same VPS — no separate hosting needed at this scale, consistent with the myMigo pattern of one VPS running everything via PM2 + git-pull deploys. CDN (Cloudflare) in front for the static assets and media, same as described in the system architecture diagram.
