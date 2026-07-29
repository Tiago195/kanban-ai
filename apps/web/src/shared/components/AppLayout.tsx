import * as React from 'react';

interface AppLayoutProps {
  title: string;
  nav?: React.ReactNode;
  children: React.ReactNode;
}

/** Layout raiz da aplicação: header com título + navegação e área de conteúdo. */
export function AppLayout({ title, nav, children }: AppLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {nav ? <nav className="flex items-center gap-2">{nav}</nav> : null}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
