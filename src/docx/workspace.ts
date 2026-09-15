/** Workspace-confined binary DOCX I/O over fs plus exclusive native publication. */

import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import '@deepseek-ai/dsh-fs'
import { constants as fsConstants } from 'node:fs'
import { link, open, rm } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface WorkspaceDocxInput {
  readonly cwd: string
  readonly inputTarget: FsTarget
  readonly inputBytes: Uint8Array
  readonly inputProcessPath: string
  readonly relativeInputPath: string
}

export interface WorkspaceDocxOutput {
  readonly path: string
  readonly relativePath: string
}

/** Resolve/read a regular, non-symlink DOCX strictly under the calling Agent's cwd. */
export async function readWorkspaceDocx(
  fs: FileSystem,
  inputPath: string,
  maxBytes: number,
  exec: ToolExecutionInput,
): Promise<WorkspaceDocxInput> {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || !isAbsolute(cwd)) {
    throw new Error('The DOCX tool requires an Agent session with an absolute workspace cwd.')
  }
  validateRelativeDocxPath(inputPath, 'input_path')
  const lexical = await fs.lstat(inputPath, { cwd }, exec.signal)
  if (lexical === undefined) throw new Error(`DOCX input ${inputPath} does not exist.`)
  if (lexical.type === 'symlink') throw new Error('DOCX input_path must not be a symbolic link.')
  if (lexical.type !== 'file') throw new Error('DOCX input_path must be a regular file.')
  if (lexical.size !== undefined && lexical.size > maxBytes) {
    throw new Error(`DOCX input exceeds the ${maxBytes}-byte limit.`)
  }
  const [workspace, inputTarget] = await Promise.all([
    fs.resolve('.', { cwd, signal: exec.signal }),
    fs.resolve(inputPath, { cwd, signal: exec.signal }),
  ])
  if (!fs.contains(workspace, inputTarget)) {
    throw new Error('DOCX input_path resolves outside the current workspace.')
  }
  const info = await fs.stat(inputTarget, exec.signal)
  if (info?.type !== 'file') throw new Error('DOCX input_path must resolve to a regular file.')
  const bytes = await fs.readBytes(inputTarget, exec.signal, maxBytes)
  const inputProcessPath = fs.processPath(inputTarget)
  const sharedCwd = fs.processPathFromHostPath(cwd)
  if (sharedCwd === undefined || resolve(sharedCwd) !== resolve(cwd)) {
    throw new Error(
      'This DOCX operation requires a local filesystem whose execution world matches the Agent workspace.',
    )
  }
  return {
    cwd,
    inputTarget,
    inputBytes: bytes,
    inputProcessPath,
    relativeInputPath: relative(cwd, inputProcessPath).replaceAll('\\', '/'),
  }
}

/** Build and prove an absent, contained sibling output target. */
export async function prepareWorkspaceOutput(
  fs: FileSystem,
  input: WorkspaceDocxInput,
  outputName: string | undefined,
  signal: AbortSignal,
): Promise<WorkspaceDocxOutput> {
  const inputPath = input.inputProcessPath
  const name =
    outputName === undefined || outputName === ''
      ? `${basename(inputPath, extname(inputPath))}.zotero.docx`
      : outputName
  if (
    name !== basename(name) ||
    extname(name).toLowerCase() !== '.docx' ||
    /[\\/:*?"<>|\u0000-\u001f]/.test(name)
  ) {
    throw new Error('output_name must be a plain .docx basename without directories.')
  }
  const outputPath = join(dirname(inputPath), name)
  if (outputPath.toLowerCase() === inputPath.toLowerCase()) {
    throw new Error('The DOCX output must be distinct from the input.')
  }
  const parentTarget = await fs.resolve(dirname(outputPath), { signal })
  const workspace = await fs.resolve('.', { cwd: input.cwd, signal })
  if (!fs.contains(workspace, parentTarget)) throw new Error('DOCX output escapes the workspace.')
  const existing = await fs.lstat(name, { cwd: dirname(inputPath) }, signal)
  if (existing !== undefined)
    throw new Error(`DOCX output ${name} already exists; it will not be overwritten.`)
  return {
    path: outputPath,
    relativePath: relative(input.cwd, outputPath).replaceAll('\\', '/'),
  }
}

/**
 * Publish bytes without replacement. A same-directory temporary file is fsynced,
 * then hard-linked to the destination: link is the portable atomic no-replace
 * operation on the local execution world and fails with EEXIST on a race.
 */
export async function publishDocxExclusive(
  output: WorkspaceDocxOutput,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason
  const temp = join(dirname(output.path), `.${basename(output.path)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      temp,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    )
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    if (signal.aborted) throw signal.reason
    await link(temp, output.path)
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

function validateRelativeDocxPath(value: string, field: string): void {
  if (value.trim() === '' || isAbsolute(value) || extname(value).toLowerCase() !== '.docx') {
    throw new Error(`${field} must be a non-empty workspace-relative .docx path.`)
  }
  const segments = value.replaceAll('\\', '/').split('/')
  if (segments.some((segment) => segment === '..' || segment === '') || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${field} must not escape the current workspace.`)
  }
  const candidate = resolve('X:\\workspace', value)
  if (relative('X:\\workspace', candidate) === `..${sep}`) {
    throw new Error(`${field} must not escape the current workspace.`)
  }
}
