#!/bin/bash
set -e

# Create feature branch
git checkout -b fix/issue-101-cache-invalidation

# Stage changes
git add src/claims/claims.service.ts
git add src/claims/claim-resolution.service.ts  
git add src/claims/claims.service.spec.ts

# Commit with issue reference
git commit -m "fix: Cache invalidation for claim resolution/finalization - Closes #101

- Invalidate claims:latest cache when resolving a claim
- Invalidate claims:latest cache when finalizing a claim  
- Add comprehensive tests to verify cache invalidation
- Both resolveClaim() and finalizeClaim() now call invalidateClaim()

Closes #101"

# Push to remote
git push -u origin fix/issue-101-cache-invalidation

echo "✅ Branch created and pushed successfully"
echo "📝 PR can now be created from fix/issue-101-cache-invalidation to main"
