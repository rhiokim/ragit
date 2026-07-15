export const MINIMUM_NODE_VERSION = "22.14.0";
export const SUPPORTED_ZVEC_TARGETS = ["darwin/arm64", "linux/arm64"] as const;

export interface NodeRuntimeSupport {
  current: string;
  minimum: string;
  supported: boolean;
}

export interface ZvecPlatformSupport {
  current: string;
  supported: boolean;
  supportedTargets: readonly string[];
}

export interface RagitRuntimeSupport {
  node: NodeRuntimeSupport;
  platform: ZvecPlatformSupport;
  supported: boolean;
}

const parseNodeVersion = (version: string): [number, number, number] | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const isAtLeast = (current: [number, number, number], minimum: [number, number, number]): boolean => {
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
};

export const getNodeRuntimeSupport = (version = process.versions.node): NodeRuntimeSupport => {
  const current = parseNodeVersion(version);
  const minimum = parseNodeVersion(MINIMUM_NODE_VERSION)!;
  return {
    current: version,
    minimum: MINIMUM_NODE_VERSION,
    supported: current !== null && isAtLeast(current, minimum),
  };
};

export const getZvecPlatformSupport = (platform = process.platform, arch = process.arch): ZvecPlatformSupport => {
  const current = `${platform}/${arch}`;
  return {
    current,
    supported: SUPPORTED_ZVEC_TARGETS.includes(current as (typeof SUPPORTED_ZVEC_TARGETS)[number]),
    supportedTargets: SUPPORTED_ZVEC_TARGETS,
  };
};

export const formatZvecPlatformSupport = (platform = process.platform, arch = process.arch): string => {
  const support = getZvecPlatformSupport(platform, arch);
  if (support.supported) return support.current;
  return `${support.current} unsupported (supported: ${support.supportedTargets.join(", ")})`;
};

export const zvecPlatformUnsupportedMessage = (platform = process.platform, arch = process.arch): string =>
  `현재 플랫폼에서는 zvec를 지원하지 않습니다: ${formatZvecPlatformSupport(platform, arch)}`;

export const isZvecPlatformSupported = (platform = process.platform, arch = process.arch): boolean =>
  getZvecPlatformSupport(platform, arch).supported;

export const getRagitRuntimeSupport = (
  nodeVersion = process.versions.node,
  platform = process.platform,
  arch = process.arch,
): RagitRuntimeSupport => {
  const node = getNodeRuntimeSupport(nodeVersion);
  const platformSupport = getZvecPlatformSupport(platform, arch);
  return {
    node,
    platform: platformSupport,
    supported: node.supported && platformSupport.supported,
  };
};

export const assertRagitRuntime = (
  nodeVersion = process.versions.node,
  platform = process.platform,
  arch = process.arch,
): void => {
  const support = getRagitRuntimeSupport(nodeVersion, platform, arch);
  if (!support.node.supported) {
    throw new Error(
      `지원되지 않는 Node.js 런타임입니다: ${support.node.current} (필수: >=${support.node.minimum})`,
    );
  }
  if (!support.platform.supported) {
    throw new Error(zvecPlatformUnsupportedMessage(platform, arch));
  }
};
