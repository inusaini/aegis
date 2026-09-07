'use client'

import { ThemeProvider } from 'next-themes'
import { AppShell } from '@/components/dashboard/app-shell'

export default function Home() {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <AppShell />
    </ThemeProvider>
  )
}
