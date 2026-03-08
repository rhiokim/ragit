'use client';
import SearchDialog from '@/components/search';
import {
  DEFAULT_PACKAGE_MANAGER,
  isPackageManager,
  PACKAGE_MANAGER_STORAGE_KEY,
  type PackageManager,
} from '@/lib/package-manager-tabs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

type PackageManagerContextValue = {
  packageManager: PackageManager;
  setPackageManager: (value: PackageManager) => void;
};

const PackageManagerContext = createContext<PackageManagerContextValue | null>(null);

function PackageManagerProvider({ children }: { children: ReactNode }) {
  const [packageManager, setPackageManager] =
    useState<PackageManager>(DEFAULT_PACKAGE_MANAGER);
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(PACKAGE_MANAGER_STORAGE_KEY);
    if (isPackageManager(stored)) {
      setPackageManager(stored);
    }
    setHasLoaded(true);
  }, []);

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }

    window.localStorage.setItem(PACKAGE_MANAGER_STORAGE_KEY, packageManager);
  }, [hasLoaded, packageManager]);

  const value = useMemo(
    () => ({
      packageManager,
      setPackageManager,
    }),
    [packageManager]
  );

  return (
    <PackageManagerContext.Provider value={value}>
      {children}
    </PackageManagerContext.Provider>
  );
}

export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider search={{ SearchDialog }}>
      <PackageManagerProvider>{children}</PackageManagerProvider>
    </RootProvider>
  );
}

export function usePackageManager() {
  const context = useContext(PackageManagerContext);
  if (!context) {
    throw new Error('usePackageManager must be used inside Provider');
  }

  return context;
}
