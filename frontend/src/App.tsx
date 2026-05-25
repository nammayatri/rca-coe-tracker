import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './contexts/AuthContext';
import Layout from './components/Layout';
import Toaster from './components/Toaster';
import CommandSearch from './components/CommandSearch';

// Route pages are code-split so the initial bundle stays small — react-markdown
// (heavy, used only on the detail page) and the admin Users page load on demand.
const RCAListPage = lazy(() => import('./pages/RCAListPage'));
const RCADetailPage = lazy(() => import('./pages/RCADetailPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // Off by default: focus refetches caused list churn while editing. Live
      // updates come from explicit invalidations and the detail page's polling.
      refetchOnWindowFocus: false,
    },
  },
});

function RouteFallback() {
  return (
    <div className="flex items-center justify-center py-24" role="status" aria-label="Loading">
      <span className="inline-block w-6 h-6 border-2 border-slate-200 border-t-blue-500 rounded-full animate-spin" />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route
                path="/"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <RCAListPage />
                  </Suspense>
                }
              />
              <Route
                path="/rcas/:id"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <RCADetailPage />
                  </Suspense>
                }
              />
              <Route
                path="/users"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <UsersPage />
                  </Suspense>
                }
              />
              <Route
                path="*"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <NotFoundPage />
                  </Suspense>
                }
              />
            </Route>
          </Routes>
          <CommandSearch />
          <Toaster />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
