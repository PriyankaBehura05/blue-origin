import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import BenefitsPage from '@/pages/BenefitsPage';
import DataPage from '@/pages/DataPage';
import DistributorsPage from '@/pages/DistributorsPage';
import NetworkPage, { NetworkLayout } from '@/pages/NetworkPage';
import ReportsPage from '@/pages/ReportsPage';
import RetailersPage from '@/pages/RetailersPage';
import SalesPage from '@/pages/SalesPage';
import TiersPage from '@/pages/TiersPage';
import LoginPage from '@/pages/LoginPage';
import UsersPage from '@/pages/UsersPage';
import { useSession } from '@/services/session';

export default function App() {
  const session = useSession();
  if (!session) return <LoginPage />; // every page needs a signed-in user
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/dashboard/overview" replace />} />
        <Route path="dashboard" element={<NetworkLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path=":tab" element={<NetworkPage />} />
        </Route>
        <Route path="sales" element={<SalesPage />} />
        <Route path="retailers" element={<RetailersPage />} />
        <Route path="distributors" element={<DistributorsPage />} />
        <Route path="tiers" element={<TiersPage />} />
        <Route path="benefits" element={<BenefitsPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="counter-report" element={<Navigate to="/reports" replace />} />
        <Route path="data" element={<DataPage />} />
        <Route path="users" element={session.user.role === 'admin' ? <UsersPage /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
