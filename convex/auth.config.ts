import type { AuthConfig } from 'convex/server'

const clerkDomain = 'https://intent-goblin-62.clerk.accounts.dev'

export default {
  providers: [
    {
      domain: clerkDomain,
      applicationID: 'convex',
    },
  ],
} satisfies AuthConfig
