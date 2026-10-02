import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Shell } from '@/components/Shell';
import { Jobs } from '@/pages/Jobs';
import { Overview } from '@/pages/Overview';
import { Runs } from '@/pages/Runs';
import { Searches } from '@/pages/Searches';
import { Soon } from '@/pages/Soon';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="runs" element={<Runs />} />
        <Route path="runs/:id" element={<Runs />} />
        <Route path="analytics" element={<Soon name="Analytics" />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="jobs/:source/:id" element={<Jobs />} />
        <Route path="searches" element={<Searches />} />
        <Route path="tools" element={<Soon name="Tools & status" />} />
        <Route path="settings" element={<Soon name="Settings" />} />
        <Route path="*" element={<Soon name="This page" />} />
      </Route>
    </Routes>
  );
}

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 1000 } } });

export function App() {
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter basename="/dashboard">
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
