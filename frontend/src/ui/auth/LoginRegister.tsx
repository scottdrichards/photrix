import React, { useState } from 'react';
import { useAuth } from '../../state/auth/AuthContext';
import { Button, Input, Tab, TabList, Spinner } from '@fluentui/react-components';

export const AuthLoginRegister: React.FC = () => {
  const { login, register, loading, error } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'login') {
      await login(username, password);
    } else {
      await register(username, email, password);
    }
  };

  return (
    <div style={{ maxWidth: 420, margin: '4rem auto', padding: '2rem' }}>
      <h2 style={{ marginTop: 0, marginBottom: '1rem' }}>Photrix</h2>
      <TabList selectedValue={mode} onTabSelect={(_, data) => setMode(data.value as typeof mode)}>
        <Tab value="login">Login</Tab>
        <Tab value="register">Register</Tab>
      </TabList>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
        <Input placeholder="Username" value={username} onChange={(_, d) => setUsername(d.value)} required />
        {mode === 'register' && (
          <Input placeholder="Email" type="email" value={email} onChange={(_, d) => setEmail(d.value)} required />
        )}
        <Input placeholder="Password" type="password" value={password} onChange={(_, d) => setPassword(d.value)} required />
        <Button type="submit" appearance="primary" disabled={loading}>
          {loading ? <Spinner size="tiny" /> : (mode === 'login' ? 'Login' : 'Create Account')}
        </Button>
        {error && <div style={{ color: '#f88', fontSize: 12 }}>{error}</div>}
      </form>
    </div>
  );
};
