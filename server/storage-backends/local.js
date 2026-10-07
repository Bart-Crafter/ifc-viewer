import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { StorageError } from "./errors.js";

// Development / test backend: each project is a plain folder on disk, shaped like a SharePoint folder
// (flat list of files plus a hidden "_viewer-cache" subfolder). File ids are the encoded file name.
export function createLocalBackend({ rootDir }) {
  // A "ref" is a folder: { path } relative to rootDir (the project's folder, or one of its sub-folders).
  const dirOf = (ref) => path.join(rootDir, ref.path);
  const cacheDirOf = (ref) => path.join(dirOf(ref), "_viewer-cache");
  const idOf = (name) => Buffer.from(name, "utf8").toString("base64url");
  const nameOf = (id) => Buffer.from(String(id), "base64url").toString("utf8");
  const safe = (name) => name && name === path.basename(name) && !name.startsWith(".");

  const entry = async (project, name) => {
    const stat = await fsp.stat(path.join(dirOf(project), name)).catch(() => null);
    if (!stat?.isFile()) return null;
    return {
      id: idOf(name),
      name,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      modifiedBy: null,
      versionKey: `${Math.round(stat.mtimeMs)}-${stat.size}`,
    };
  };

  const put = async (project, name, tmpPath, { overwrite }) => {
    const dest = path.join(dirOf(project), name);
    if (!overwrite && fs.existsSync(dest)) throw new StorageError("exists");
    await fsp.mkdir(dirOf(project), { recursive: true });
    await fsp.copyFile(tmpPath, dest);
    return entry(project, name);
  };

  return {
    kind: "local",

    // Make sure the named sub-folders exist; returns { name: id }. Locally the name is the id.
    async ensureFolders(ref, names) {
      const out = {};
      for (const name of names) {
        await fsp.mkdir(path.join(dirOf(ref), name), { recursive: true });
        out[name] = name;
      }
      return out;
    },
    async readNamed(ref, name) {
      return fsp.readFile(path.join(dirOf(ref), name)).catch(() => null);
    },
    async writeNamed(ref, name, buffer) {
      await fsp.mkdir(dirOf(ref), { recursive: true });
      await fsp.writeFile(path.join(dirOf(ref), name), buffer);
    },
    async describeFolder() {
      return { name: null };
    },
    async list(project) {
      await fsp.mkdir(dirOf(project), { recursive: true });
      const names = await fsp.readdir(dirOf(project));
      return (await Promise.all(names.filter(safe).map((n) => entry(project, n)))).filter(Boolean);
    },
    async get(project, id) {
      const name = nameOf(id);
      return safe(name) ? entry(project, name) : null;
    },
    async read(project, id) {
      const file = await this.get(project, id);
      if (!file) throw new StorageError("missing");
      return { stream: fs.createReadStream(path.join(dirOf(project), file.name)), size: file.size };
    },
    create: (project, name, tmpPath) => put(project, name, tmpPath, { overwrite: false }),
    async replace(project, id, tmpPath) {
      const file = await this.get(project, id);
      if (!file) throw new StorageError("missing");
      return put(project, file.name, tmpPath, { overwrite: true });
    },
    async rename(project, id, newName) {
      const file = await this.get(project, id);
      if (!file) throw new StorageError("missing");
      const to = path.join(dirOf(project), newName);
      if (newName !== file.name && fs.existsSync(to)) throw new StorageError("exists");
      await fsp.rename(path.join(dirOf(project), file.name), to);
      return entry(project, newName);
    },
    async remove(project, id) {
      const file = await this.get(project, id);
      if (!file) throw new StorageError("missing");
      await fsp.rm(path.join(dirOf(project), file.name), { force: true });
    },

    // conversion cache
    async cacheList(project) {
      const names = await fsp.readdir(cacheDirOf(project)).catch(() => []);
      return new Set(names);
    },
    async cacheRead(project, name) {
      const p = path.join(cacheDirOf(project), name);
      const stat = await fsp.stat(p).catch(() => null);
      if (!stat?.isFile()) throw new StorageError("missing");
      return { stream: fs.createReadStream(p), size: stat.size };
    },
    async cacheWrite(project, name, buffer) {
      await fsp.mkdir(cacheDirOf(project), { recursive: true });
      await fsp.writeFile(path.join(cacheDirOf(project), name), buffer);
    },
    async cachePurge(project, prefix, keep = []) {
      const names = await fsp.readdir(cacheDirOf(project)).catch(() => []);
      await Promise.all(
        names.filter((n) => n.startsWith(prefix) && !keep.includes(n)).map((n) => fsp.rm(path.join(cacheDirOf(project), n), { force: true }))
      );
    },
  };
}
