"use client";

import { useState, type ReactNode } from "react";
import { login, isLoggedIn, getAuthRole, logout } from "@/lib/api";
import { ShieldAlert, LogOut } from "lucide-react";

export function LoginGate({ children, onAuthChange }: { children: ReactNode; onAuthChange?: (role: "user" | "guest" | null) => void }) {
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());
  const [role, setRole] = useState(getAuthRole());
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(asGuest: boolean) {
    setLoading(true);
    setError("");
    try {
      const result = await login(asGuest ? "" : password);
      setRole(result.role);
      setLoggedIn(true);
      onAuthChange?.(result.role);
    } catch {
      setError("Login failed. Check your password.");
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    logout();
    setLoggedIn(false);
    setRole(null);
    setPassword("");
    onAuthChange?.(null);
  }

  if (!loggedIn) {
    return (
      <div className="flex items-center justify-center h-full" style={{ backgroundColor: "#f4f2f7" }}>
        <div className="bg-white rounded-2xl shadow-sm shadow-black/5 ring-1 ring-black/[0.04] p-8 w-full max-w-sm">
          <div className="flex items-center gap-2 mb-6">
            <ShieldAlert className="w-6 h-6 text-orange-500" />
            <h1 className="text-lg font-semibold">Enfuce AML Screener</h1>
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); handleLogin(false); }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-black/10 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/30"
                placeholder="Enter password"
                autoFocus
              />
            </div>

            {error && (
              <p className="text-sm text-red-500">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-2 rounded-lg bg-foreground text-white text-sm font-medium hover:opacity-90 transition disabled:opacity-40"
            >
              {loading ? "Logging in..." : "Log in"}
            </button>
          </form>

          <div className="mt-4 pt-4 border-t border-black/5">
            <button
              onClick={() => handleLogin(true)}
              disabled={loading}
              className="w-full py-2 rounded-lg border border-black/10 text-sm text-muted-foreground hover:bg-black/[0.02] transition disabled:opacity-40"
            >
              Continue as guest
            </button>
            <p className="mt-2 text-xs text-muted-foreground text-center">
              Guests can perform single-name searches only
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Role badge + logout */}
      <div className="absolute top-3 right-6 z-50 flex items-center gap-2">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
          role === "user"
            ? "bg-green-100 text-green-700"
            : "bg-amber-100 text-amber-700"
        }`}>
          {role === "user" ? "Full access" : "Guest"}
        </span>
        <button
          onClick={handleLogout}
          className="text-muted-foreground hover:text-foreground transition"
          title="Log out"
        >
          <LogOut className="w-3.5 h-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}
