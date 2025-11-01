import fs from 'node:fs';
import path from 'node:path';
import { runShellCommand, getChangedFiles } from '../utils/utils.js';

function planRelease(ctx, fsApi) {
  const { isMultiRelease, isMainBranch } = ctx;
  const steps = [];
  const planFilePath = fsApi.resolve(process.cwd(), '.release-meta', 'maintenance-branches.json');
  const planFileExists = fsApi.existsSync(planFilePath);
  const plan = planFileExists ? JSON.parse(fsApi.readFileSync(planFilePath, 'utf-8')) : {};

  if (Object.getOwnPropertyNames(plan).length > 0 && isMultiRelease && isMainBranch) {
    for (const pkgName in plan) {
      const { branchName } = plan[pkgName];
      steps.push({ type: 'ensure-maintenance-branch', branchName });
    }
  }

  steps.push({ type: 'exec', cmd: 'pnpm changeset publish' });

  console.log(`planned release steps: ${steps.map((s) => s.type).join(', ')}`);

  return steps;
}

function executeSteps(steps, shell) {
  for (const step of steps) {
    switch (step.type) {
      case 'log-warn': {
        console.warn(step.msg);
        break;
      }

      case 'exec': {
        runShellCommand(step.cmd, shell, { stdio: 'inherit' });
        break;
      }

      case 'ensure-maintenance-branch': {
        const { branchName } = step;

        console.log(`Checking for branch '${branchName}'...`);

        const { stdout } = runShellCommand(`git ls-remote --heads origin ${branchName}`, shell, { stdio: 'pipe' });
        const branchExists = stdout.trim() !== '';

        if (!branchExists) {
          console.log(`Creating '${branchName}'...`);
          // Create branch from the commit before the "Version Packages" merge commit
          runShellCommand(`git branch ${branchName} HEAD~1`, shell);
          runShellCommand(`git push origin ${branchName}`, shell);
          console.log(`✅ Created and pushed '${branchName}' from previous commit.`);
        } else {
          console.log(`✅ Branch '${branchName}' already exists.`);
        }
        break;
      }

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }
}

function getReleaseContext(env) {
  const isMultiRelease = env.ENABLE_MULTI_RELEASE === 'true';
  const branchName = env.GITHUB_REF_NAME;
  const isReleaseBranch = Boolean(branchName && branchName.startsWith('release/'));
  const isMainBranch = branchName === 'main';


  return {
    isMultiRelease,
    branchName,
    isReleaseBranch,
    isMainBranch
  };
}

async function validatePreconditions(ctx, shell) {
  const { branchName, isMultiRelease, isReleaseBranch, isMainBranch } = ctx;

  // Instead of checking commit messages, we check for file changes, which is more robust.
  // A release commit from `changeset version` will always modify package.json and/or CHANGELOG.md files.
  const changedFiles = await getChangedFiles(shell);
  const latestChangesAreReleaseChanges = changedFiles.some(file => file.endsWith('package.json') || file.endsWith('CHANGELOG.md'));

  if (!isMainBranch && !isReleaseBranch && isMultiRelease) {
    console.warn(`Skipping release : on branch ${branchName}. for Multi-Release mode .`);
    return { proceedWithRelease: false };
  }

  console.log(`Checking for release commit by inspecting changed files in HEAD...`);

  if (latestChangesAreReleaseChanges) {
    console.log('✅ Versioning changes detected (package.json, CHANGELOG.md, or .changeset/ files modified). Proceeding with release.');
    return { proceedWithRelease: true };
  }

  return { proceedWithRelease: false }
}

export async function main(
  env = process.env,
  fsApi = fs,
  shell = exec
) {
  console.log('🚀 Starting release script...');

  const ctx = getReleaseContext(env);
  const steps = [];
  const { proceedWithRelease } = await validatePreconditions(ctx, shell);

  console.log(`🔍 Current branch: ${ctx.branchName}`);
  console.log(`🔍 Multi-release mode: ${ctx.isMultiRelease}`);
  console.log(`Proceed with release: ${proceedWithRelease}`);

  if (proceedWithRelease) {
    steps.push(...planRelease(ctx, fsApi));
  }

  console.log('📝 Planned steps:', steps.map((s) => s.type).join(', '));

  if (steps.length === 0)
    console.log('ℹ️ Skipping release process: No steps to execute.');
  else {
    executeSteps(steps, shell);
    console.log('✅ Release process completed successfully.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (err) {
    // If the error is about skipping, it's not a failure.
    if (err.message.includes('Skipping release process')) {
      console.log(`✅ ${err.message}`);
      process.exit(0);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  }
}
