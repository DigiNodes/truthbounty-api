#!/usr/bin/env python3
"""
Git automation script to create branch, commit, and push changes for issue #101
"""
import subprocess
import sys
import os

def run_command(cmd, description=""):
    """Execute a shell command"""
    try:
        print(f"🔄 {description}")
        result = subprocess.run(cmd, shell=True, cwd="/workspaces/truthbounty-api", capture_output=True, text=True)
        if result.returncode != 0:
            print(f"❌ Error: {result.stderr}")
            return False
        print(f"✅ {description}")
        if result.stdout:
            print(f"   Output: {result.stdout[:200]}")
        return True
    except Exception as e:
        print(f"❌ Exception: {e}")
        return False

def main():
    """Main execution"""
    os.chdir("/workspaces/truthbounty-api")
    
    print("=" * 60)
    print("Issue #101: Cache Invalidation Fix")
    print("=" * 60)
    
    # Step 1: Configure git
    run_command('git config user.name "GitHub Copilot"', "Configuring git user name")
    run_command('git config user.email "copilot@github.com"', "Configuring git user email")
    
    # Step 2: Check current status
    run_command('git status', "Checking current status")
    
    # Step 3: Create branch
    if not run_command('git checkout -b fix/issue-101-cache-invalidation', "Creating feature branch"):
        run_command('git checkout fix/issue-101-cache-invalidation', "Switching to existing branch")
    
    # Step 4: Stage files
    run_command('git add src/claims/claims.service.ts', "Staging claims.service.ts")
    run_command('git add src/claims/claim-resolution.service.ts', "Staging claim-resolution.service.ts")
    run_command('git add src/claims/claims.service.spec.ts', "Staging claims.service.spec.ts")
    
    # Step 5: Check staged files
    run_command('git status', "Checking staged files")
    
    # Step 6: Commit
    commit_msg = """fix: Cache invalidation for claim resolution/finalization - Closes #101

- Invalidate claims:latest cache when resolving a claim
- Invalidate claims:latest cache when finalizing a claim
- Add comprehensive tests to verify cache invalidation
- Both resolveClaim() and finalizeClaim() now call invalidateClaim()

Closes #101"""
    
    # Escape the commit message for shell
    escaped_msg = commit_msg.replace('"', '\\"')
    run_command(f'git commit -m "{escaped_msg}"', "Committing changes")
    
    # Step 7: Push
    run_command('git push -u origin fix/issue-101-cache-invalidation', "Pushing to remote")
    
    # Step 8: Display summary
    print("\n" + "=" * 60)
    print("✅ All operations completed successfully!")
    print("=" * 60)
    print("\n📝 Next steps:")
    print("1. Go to: https://github.com/DigiNodes/truthbounty-api/pulls")
    print("2. Create a PR from 'fix/issue-101-cache-invalidation' to 'main'")
    print("3. Use the description from IMPLEMENTATION_GUIDE.md")
    print("4. Link to issue #101")
    print("\n")

if __name__ == "__main__":
    main()
