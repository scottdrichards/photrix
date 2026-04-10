import { render, screen, waitFor } from "@testing-library/react";
import { AuthGate, useAuthSession } from "./AuthGate";

const getAuthSessionMock = vi.fn();
const loginWithPasskeyMock = vi.fn();
const registerWithPasskeyMock = vi.fn();
const signOutMock = vi.fn();

vi.mock("./authApi", () => ({
  getAuthSession: (...args: unknown[]) => getAuthSessionMock(...args),
  loginWithPasskey: (...args: unknown[]) => loginWithPasskeyMock(...args),
  registerWithPasskey: (...args: unknown[]) => registerWithPasskeyMock(...args),
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

const ChildComponent = () => {
  const { username } = useAuthSession();
  return <div data-testid="child">Logged in as {username}</div>;
};

describe("AuthGate", () => {
  beforeEach(() => {
    getAuthSessionMock.mockReset();
    loginWithPasskeyMock.mockReset();
    registerWithPasskeyMock.mockReset();
    signOutMock.mockReset();
  });

  it("renders children when authenticated", async () => {
    getAuthSessionMock.mockResolvedValue({
      authEnabled: true,
      setupRequired: false,
      authenticated: true,
      username: "scott",
    });

    render(
      <AuthGate>
        <ChildComponent />
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("child")).toHaveTextContent("Logged in as scott");
    });
  });

  it("shows login form when auth is enabled and not authenticated", async () => {
    getAuthSessionMock.mockResolvedValue({
      authEnabled: true,
      setupRequired: false,
      authenticated: false,
      username: null,
    });

    render(
      <AuthGate>
        <ChildComponent />
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByText("Sign in to Photrix")).toBeInTheDocument();
    });
  });

  it("renders children when auth is disabled, even without a session", async () => {
    getAuthSessionMock.mockResolvedValue({
      authEnabled: false,
      setupRequired: false,
      authenticated: false,
      username: null,
    });

    render(
      <AuthGate>
        <ChildComponent />
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("child")).toHaveTextContent("Logged in as auth-disabled");
    });
  });
});
