/**
 * src/store/authStore.ts
 *
 * Zustand auth store — single source of truth for client-side identity.
 *
 * Architecture:
 *  • Backed by Zustand `persist` middleware with AsyncStorage.
 *  • On cold-start, `onRehydrateStorage` calls `initialize()` to flip
 *    `isLoading` to false after hydration, preventing route flicker.
 *  • `logout()` invalidates both the local state AND the Supabase JWT
 *    session on the server.
 *
 * Security:
 *  • No credentials are stored here. The User object only contains
 *    profile data resolved AFTER successful Supabase OTP verification.
 *  • The Supabase JWT is managed exclusively by the Supabase JS client
 *    in its own AsyncStorage slot — this store only tracks app-level
 *    user identity.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase/supabaseClient';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Resolved user profile object. Populated after successful OTP verification
 * or OAuth sign-in, sourced from `public.profiles` and the Supabase session.
 */
export interface User {
  /** Supabase `auth.users.id` — the primary identity key. */
  id: string;
  name: string;
  phone: string;
  email?: string;
  age?: string;
  pincode?: string;
  address?: string;
  latitude?: string;
  longitude?: string;
  notificationsEnabled?: boolean;
  privacyOrderDefault?: boolean;
  preferredLanguage?: string;
  /** True when a phone OTP was successfully verified during this session. */
  phoneVerified?: boolean;
  /** True when email OTP or Google/Apple OAuth was successfully completed. */
  emailVerified?: boolean;
}

interface AuthState {
  // ── State ──────────────────────────────────────────────────────────────
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  hasCompletedOnboarding: boolean;
  hasAcceptedConsent: boolean;
  /** True while AsyncStorage is being hydrated on cold-start. */
  isLoading: boolean;

  // ── Actions ────────────────────────────────────────────────────────────
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  /**
   * Full logout: clears local state AND calls supabase.auth.signOut()
   * to invalidate the server-side JWT session.
   */
  logout: () => Promise<void>;
  completeOnboarding: () => void;
  acceptConsent: () => void;
  /**
   * Merges partial updates into the current user object.
   * No-ops if no user is in the store.
   */
  updateUser: (updates: Partial<User>) => void;
  /** Called automatically by onRehydrateStorage; sets isLoading = false. */
  initialize: () => Promise<void>;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      // ── Initial state ────────────────────────────────────────────────
      user: null,
      token: null,
      isAuthenticated: false,
      hasCompletedOnboarding: false,
      hasAcceptedConsent: false,
      isLoading: true,

      // ── Actions ──────────────────────────────────────────────────────

      setUser: (user: User | null) =>
        set({ user, isAuthenticated: !!user }),

      setToken: (token: string | null) =>
        set({ token }),

      /**
       * Clears the local auth state and invalidates the Supabase JWT.
       * Errors from signOut are swallowed — local state is always cleared
       * regardless of network availability.
       */
      logout: async () => {
        try {
          await supabase.auth.signOut();
        } catch (err) {
          // Network unavailable or session already expired — safe to ignore.
          if (__DEV__) {
            console.warn('[authStore] supabase.auth.signOut() error (ignored):', err);
          }
        }
        set({
          user: null,
          token: null,
          isAuthenticated: false,
        });
      },

      completeOnboarding: () =>
        set({ hasCompletedOnboarding: true }),

      acceptConsent: () =>
        set({ hasAcceptedConsent: true }),

      /**
       * Merges partial updates into the current user object.
       * No-ops if user is null to prevent phantom state.
       */
      updateUser: (updates: Partial<User>) =>
        set((state: AuthState) => {
          if (!state.user) {
            if (__DEV__) {
              console.warn('[authStore] updateUser called with no user in store.');
            }
            return {};
          }
          return {
            user: { ...state.user, ...updates },
            isAuthenticated: true,
          };
        }),

      /**
       * Called by onRehydrateStorage once AsyncStorage hydration completes.
       * Flips isLoading to false so AppNavigator renders the correct route.
       */
      initialize: async () => {
        set({ isLoading: false });
      },
    }),

    // ── Persist config ──────────────────────────────────────────────────
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => AsyncStorage),

      /**
       * Only serialize safe, non-ephemeral fields.
       * `isLoading` is intentionally excluded.
       */
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
        hasCompletedOnboarding: state.hasCompletedOnboarding,
        hasAcceptedConsent: state.hasAcceptedConsent,
      }),

      onRehydrateStorage: () => (state) => {
        state?.initialize();
      },
    },
  ),
);
