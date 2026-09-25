/**
 * src/screens/Auth/LoginScreen.tsx
 *
 * Credential collection layer — the first authenticated screen users see.
 *
 * Auth Methods:
 *  1. Phone-first  → looks up linked email → dual-option card (email OTP / SMS OTP)
 *  2. Email OTP    → direct Supabase email OTP dispatch
 *  3. Google OAuth → ID-token exchange via supabase.auth.signInWithIdToken()
 *  4. Apple OAuth  → supabase.auth.signInWithOAuth({ provider: 'apple' })
 *
 * Security:
 *  • No credentials hardcoded. All config sourced from ENV via supabaseClient.
 *  • Email addresses are masked before display (e.g. jo***n@gmail.com).
 *  • Age verification checkbox is a hard gate before OTP dispatch.
 *  • All OTP generation happens server-side (Supabase or Edge Function).
 */

import React, { useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  StatusBar,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import { StackScreenProps } from '@react-navigation/stack';
import { GoogleSignin } from '@react-native-google-signin/google-signin';

// Screens / Sub-components
import HeroSection from './components/HeroSection';
import PhoneInputField from './components/PhoneInputField';
import OTPButton from './components/OTPButton';
import SocialAuthButtons from './components/SocialAuthButtons';
import AgeVerificationCheckbox from './components/AgeVerificationCheckbox';
import TermsFooter from './components/TermsFooter';

// Theme, auth, and services
import { colors } from '../../theme/colors';
import { Icon } from '../../components/common/Icon';
import { supabase } from '../../lib/supabase/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import { supabaseOtpBridge } from '../../lib/supabaseOtpBridge';
import { RootStackParams } from '../../navigation/AppNavigator';
import { findLinkedEmailByPhone } from '../../services/authLookupService';

type LoginScreenProps = StackScreenProps<RootStackParams, 'Login'>;

// ─── Helper: Safely Mask Email ──────────────────────────────────────────────
/**
 * Returns a privacy-safe masked version of an email address for display.
 * Format: <first 2 chars>***<last char>@<domain>
 * Example: "jonathan@gmail.com" → "jo***n@gmail.com"
 * Never used for verification — display-only.
 */
const maskEmail = (emailStr: string): string => {
  if (!emailStr) return '';
  const [name, domain] = emailStr.split('@');
  if (!domain) return emailStr;
  if (name.length <= 2) return `${name[0]}***@${domain}`;
  const firstPart = name.substring(0, 2);
  const lastChar = name.slice(-1);
  return `${firstPart}***${lastChar}@${domain}`;
};

// ─── Screen ──────────────────────────────────────────────────────────────────
/**
 * LoginScreen — credential collection entry point.
 * Manages login method state (phone / email), input validation,
 * OTP dispatch, and social auth initiation.
 */
const LoginScreen: React.FC<LoginScreenProps> = ({ navigation }) => {
  const { login } = useAuth();
  const [loginMethod, setLoginMethod] = useState<'phone' | 'email'>('phone');
  const [phone, setPhone] = useState('');
  const [linkedEmail, setLinkedEmail] = useState<string | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [email, setEmail] = useState('');
  const [ageVerified, setAgeVerified] = useState(false);
  const [loading, setLoading] = useState(false);

  // Strips country code from Google Phone Hint and fills local 10-digit field
  const handleNumberHinted = (rawNumber: string) => {
    const digitsOnly = rawNumber.replace(/\D/g, '');
    const local = digitsOnly.slice(-10);
    if (local.length === 10) {
      setPhone(local);
      setShowOptions(false);
      setLinkedEmail(null);
    }
  };

  const isEmailValid = (e: string) => e.includes('@') && e.includes('.') && e.length > 5;

  const isValid = loginMethod === 'phone'
    ? (phone.length === 10 && ageVerified)
    : (isEmailValid(email) && ageVerified);

  /**
   * Phone tab primary action.
   *
   * Flow:
   *  1. Run 4-layer phone→email lookup (RPC → profiles → cache → store).
   *  2. If a linked email is found, surface the dual-option card so the
   *     user can choose Email OTP (free & instant) or SMS OTP.
   *  3. If no linked email is found, attempt a direct SMS OTP via Supabase.
   *     On SMS error, offer Email OTP or account creation.
   */
  const checkExistingUserAndSend = async () => {
    if (!isValid) return;
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const fullPhone = `+91${cleanPhone}`;
    setLoading(true);

    try {
      // 1. Resilient multi-layer lookup (RPC → profiles → local cache → store)
      const foundEmail = await findLinkedEmailByPhone(cleanPhone);

      if (foundEmail) {
        // Existing user with a linked email → show dual delivery options
        setLinkedEmail(foundEmail);
        setShowOptions(true);
      } else {
        // No linked email → attempt direct Supabase phone OTP
        const { error: smsErr } = await supabase.auth.signInWithOtp({
          phone: fullPhone,
        });

        if (smsErr) {
          // SMS unavailable or account not found → offer alternatives
          Alert.alert(
            'Account Lookup',
            `No account is linked with +91 ${cleanPhone}.\n\nPlease sign up or use your email address to receive a secure OTP.`,
            [
              {
                text: 'Use Email OTP',
                onPress: () => { setLoginMethod('email'); setShowOptions(false); },
              },
              {
                text: 'Create Account',
                onPress: () => navigation.navigate('Register'),
              },
              { text: 'Cancel', style: 'cancel' },
            ],
          );
        } else {
          navigation.navigate('OTP', { phone: fullPhone });
        }
      }
    } catch (err: any) {
      console.error('[LoginScreen] checkExistingUserAndSend error:', err);
      Alert.alert('Error', err.message || 'Failed to check account. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Option 1: Send OTP to Linked Email (Free & Instant) ─────────────────
  const handleSendLinkedEmailOTP = async () => {
    if (!linkedEmail) return;
    const cleanEmail = linkedEmail.toLowerCase().trim();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: { shouldCreateUser: true },
      });
      if (error) throw error;
      supabaseOtpBridge.set(cleanEmail);
      console.log('✅ Supabase Email OTP sent to linked email:', cleanEmail);
      navigation.navigate('OTP', { phone: cleanEmail, linkedEmail: cleanEmail });

    } catch (error: any) {
      Alert.alert('Could Not Send OTP', error.message || 'Failed to send OTP to linked email.');
    } finally {
      setLoading(false);
    }
  };

  // ── Option 2: Send OTP via SMS (Direct Phone) ───────────────────────────
  const handleSendPhoneSMSOTP = async () => {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const fullPhone = `+91${cleanPhone}`;
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        phone: fullPhone,
      });
      if (error) {
        Alert.alert(
          'SMS Gateway Inactive',
          'SMS OTP delivery is currently unavailable. Please tap "Send to Email" to receive your OTP instantly.',
          [
            { text: 'Send to Email', onPress: handleSendLinkedEmailOTP },
            { text: 'Cancel', style: 'cancel' },
          ]
        );
        return;
      }
      navigation.navigate('OTP', { phone: fullPhone, linkedEmail: linkedEmail || undefined });

    } catch (error: any) {
      Alert.alert('SMS Failed', error.message || 'Could not send SMS OTP.');
    } finally {
      setLoading(false);
    }
  };


  /**
   * Email tab primary action.
   *
   * Dispatches a 6-digit OTP to the entered email address via Supabase Auth.
   * `shouldCreateUser: true` allows first-time sign-ups without a separate
   * registration step for email-only users.
   *
   * The pending email is parked in `supabaseOtpBridge` so OTPScreen can
   * call `verifyOtp({ type: 'email' })` with the correct target.
   */
  const handleSendOTP = async () => {
    if (!isValid) return;
    const cleanEmail = email.replace(/\s+/g, '').toLowerCase();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: { shouldCreateUser: true },
      });
      if (error) {
        Alert.alert('Error', error.message || 'Failed to send OTP. Please try again.');
        return;
      }
      // Park email so OTPScreen knows to call verifyOtp with type: 'email'
      supabaseOtpBridge.set(cleanEmail);
      navigation.navigate('OTP', { phone: cleanEmail });
    } catch (err: any) {
      Alert.alert(
        'Could Not Send OTP',
        err.message || 'Failed to send OTP. Please check your email and try again.',
      );
    } finally {
      setLoading(false);
    }
  };



  /**
   * Google OAuth flow.
   *
   * Steps:
   *  1. hasPlayServices() — confirms Google Play Services available (Android).
   *  2. signOut() — clears cached Google session so the account picker always
   *     shows all Gmail accounts on the device, not just the last one used.
   *  3. signIn() — triggers the native Google account picker.
   *  4. signInWithIdToken() — exchanges the Google ID token with Supabase.
   *     Supabase validates the token against Google's JWKS endpoint server-side.
   *  5. Profile lookup → existing user or new user routing.
   *
   * Security: the ID token is never validated client-side.
   */
  const handleGoogleSignIn = async () => {
    setLoading(true);
    try {
      // 1. Ensure Google Play Services are available
      await GoogleSignin.hasPlayServices();

      // 2. Clear cached Google session so the native account picker always shows all available Gmail accounts on the device
      try {
        await GoogleSignin.signOut();
      } catch (signOutErr) {
        // Ignored if user was not previously signed in
      }

      // 3. Trigger native Google Sign-In picker
      const userInfo = await GoogleSignin.signIn();

      if (!userInfo.data?.idToken) {
        throw new Error('Google sign-in did not return an ID token. Please try again.');
      }

      // 3. Exchange Google ID token with Supabase
      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: userInfo.data.idToken,
      });

      if (error) throw error;

      const sessionUser = data.user;
      if (!sessionUser) throw new Error('Supabase returned no user. Please try again.');

      const finalId = sessionUser.id;
      const finalEmail = sessionUser.email || sessionUser.user_metadata?.email || '';
      const finalName =
        sessionUser.user_metadata?.full_name ||
        sessionUser.user_metadata?.name ||
        '';

      // 4. Check if profile already exists
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', finalId)
        .maybeSingle();

      if (profile) {
        // Existing user — check if phone is present
        if (!profile.phone) {
          // Profile exists but no phone — collect it
          await login({
            id: profile.id,
            name: profile.full_name || finalName,
            phone: '',
            email: profile.email || finalEmail,
            age: profile.age || '18',
            pincode: profile.pincode || '',
            address: profile.current_address || profile.address || '',
            latitude: profile.latitude ? profile.latitude.toString() : undefined,
            longitude: profile.longitude ? profile.longitude.toString() : undefined,
            emailVerified: true,
            phoneVerified: false,
          });
          navigation.navigate('AddPhone', { fromProfile: false });
        } else {
          // Full profile — go straight to main
          await login({
            id: profile.id,
            name: profile.full_name || finalName,
            phone: profile.phone || '',
            email: profile.email || finalEmail,
            age: profile.age || '18',
            pincode: profile.pincode || '',
            address: profile.current_address || profile.address || '',
            latitude: profile.latitude ? profile.latitude.toString() : undefined,
            longitude: profile.longitude ? profile.longitude.toString() : undefined,
            emailVerified: true,
            phoneVerified: !!profile.phone_verified,
          });
          navigation.replace('Main');
        }
      } else {
        // New user — go to CompleteProfile to collect name/DOB/phone/location
        navigation.navigate('CompleteProfile', {
          email: finalEmail,
          name: finalName,
          userId: finalId,
          authMethod: 'google',
        });
      }
    } catch (error: any) {
      if (error.code === 'SIGN_IN_CANCELLED') {
        // User dismissed the picker — silent
        return;
      }
      console.error('[Google Sign-In] Error:', error);
      Alert.alert(
        'Google Sign-In Failed',
        error.message || 'Could not sign in with Google. Please check your internet connection and try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  /**
   * Apple OAuth flow.
   *
   * Uses Supabase's `signInWithOAuth` browser redirect. In a React Native
   * context this requires a deep-link redirect URI registered in your
   * Supabase project and Info.plist (iOS). If the OAuth redirect does not
   * resolve a session (e.g., in development without a deep-link handler),
   * we surface a graceful error rather than using mock data.
   *
   * Production hardening recommendation:
   *  Use `@invertase/react-native-apple-authentication` combined with
   *  `supabase.auth.signInWithIdToken({ provider: 'apple', token: identityToken })`
   *  for a fully native, reliable Apple Sign-In flow.
   */
  const handleAppleSignIn = async () => {
    setLoading(true);
    try {
      // Initiate Supabase Apple OAuth (browser redirect)
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'apple',
      });

      if (oauthError) {
        throw oauthError;
      }

      // Attempt to read the session after the redirect resolves
      const { data: { session } } = await supabase.auth.getSession();
      const sessionUser = session?.user;

      if (!sessionUser) {
        // Deep-link handler not yet wired up — session not yet available.
        // This is expected in development without a custom URL scheme configured.
        Alert.alert(
          'Apple Sign-In',
          'Sign-in initiated. Please complete the process in the browser window that opened.',
        );
        return;
      }

      const finalId = sessionUser.id;
      const finalEmail = sessionUser.email || sessionUser.user_metadata?.email || '';
      const finalName =
        sessionUser.user_metadata?.full_name ||
        sessionUser.user_metadata?.name ||
        '';

      // Query profiles
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', finalId)
        .maybeSingle();

      if (profile) {
        await login({
          id: profile.id,
          name: profile.full_name || finalName,
          phone: profile.phone || '',
          email: profile.email || finalEmail,
          age: profile.age || '18',
          pincode: profile.pincode || '',
          address: profile.current_address || profile.address || '',
          latitude: profile.latitude ? profile.latitude.toString() : undefined,
          longitude: profile.longitude ? profile.longitude.toString() : undefined,
          emailVerified: true,
          phoneVerified: !!profile.phone_verified,
        });
        navigation.replace('Main');
      } else {
        navigation.navigate('Register', {
          phone: 'apple',
          email: finalEmail,
          name: finalName,
          userId: finalId,
        });
      }
    } catch (err: any) {
      Alert.alert('Apple Sign-In Failed', err.message || 'Could not sign in with Apple. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <View style={styles.root}>
        <StatusBar
          barStyle="light-content"
          backgroundColor={colors.primary}
          translucent={false}
        />

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Hero (lite purple top section) ──────────────────────── */}
          <HeroSection />

          {/* ── White card below hero ──────────────────────────────── */}
          <View style={styles.card}>

            {/* Tabs */}
            <View style={styles.tabContainer}>
              <TouchableOpacity
                style={[styles.tabButton, loginMethod === 'phone' && styles.tabButtonActive]}
                onPress={() => {
                  setLoginMethod('phone');
                  setShowOptions(false);
                }}
                activeOpacity={0.8}
              >
                <View style={styles.tabContentRow}>
                  <Icon
                    family="mci"
                    name="cellphone-text"
                    size={18}
                    color={loginMethod === 'phone' ? colors.primary : colors.textSecondary}
                    style={{ marginRight: 6 }}
                  />
                  <Text style={[styles.tabText, loginMethod === 'phone' && styles.tabTextActive]}>
                    Mobile OTP
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tabButton, loginMethod === 'email' && styles.tabButtonActive]}
                onPress={() => {
                  setLoginMethod('email');
                  setShowOptions(false);
                }}
                activeOpacity={0.8}
              >
                <View style={styles.tabContentRow}>
                  <Icon
                    family="mci"
                    name="email-outline"
                    size={18}
                    color={loginMethod === 'email' ? colors.primary : colors.textSecondary}
                    style={{ marginRight: 6 }}
                  />
                  <Text style={[styles.tabText, loginMethod === 'email' && styles.tabTextActive]}>
                    Email OTP
                  </Text>
                </View>
              </TouchableOpacity>
            </View>

            {/* Input fields */}
            {loginMethod === 'phone' ? (
              <View>
                <PhoneInputField
                  value={phone}
                  onChangeText={(t) => {
                    setPhone(t);
                    if (showOptions) {
                      setShowOptions(false);
                      setLinkedEmail(null);
                    }
                  }}
                  countryCode="+91"
                  editable={!showOptions}
                  onNumberHinted={handleNumberHinted}
                />

                {/* ── Dual Options Card when Account is Located ─────────── */}
                {showOptions && linkedEmail ? (
                  <View style={styles.optionsContainer}>
                    <View style={styles.optionsHeaderRow}>
                      <View style={styles.checkBadge}>
                        <Icon family="mci" name="check-bold" size={14} color={colors.white} />
                      </View>
                      <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text style={styles.optionsTitle}>Account Located</Text>
                        <Text style={styles.optionsSubtitle}>
                          How would you like to receive your 6-digit OTP?
                        </Text>
                      </View>
                    </View>

                    {/* Option 1: Send OTP to Masked Email (Recommended / Free) */}
                    <TouchableOpacity
                      style={styles.optionEmailButton}
                      onPress={handleSendLinkedEmailOTP}
                      activeOpacity={0.85}
                      disabled={loading}
                    >
                      <View style={styles.optionIconCircle}>
                        <Icon family="mci" name="email-fast" size={20} color={colors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                          <Text style={styles.optionEmailTitle}>
                            Send OTP to {maskEmail(linkedEmail)}
                          </Text>
                        </View>
                        <Text style={styles.optionEmailHint}>Instant • Free & Secure</Text>
                      </View>
                      <Icon family="mci" name="chevron-right" size={20} color={colors.primary} />
                    </TouchableOpacity>

                    {/* Option 2: Send OTP via SMS */}
                    <TouchableOpacity
                      style={styles.optionSmsButton}
                      onPress={handleSendPhoneSMSOTP}
                      activeOpacity={0.8}
                      disabled={loading}
                    >
                      <View style={styles.optionSmsIconCircle}>
                        <Icon family="mci" name="message-text-outline" size={18} color={colors.textSecondary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.optionSmsTitle}>Send OTP via SMS (+91 {phone})</Text>
                        <Text style={styles.optionSmsHint}>Carrier SMS delivery</Text>
                      </View>
                      <Icon family="mci" name="chevron-right" size={20} color={colors.textMuted} />
                    </TouchableOpacity>

                    {/* Change Number Button */}
                    <TouchableOpacity
                      style={styles.changeNumberButton}
                      onPress={() => {
                        setShowOptions(false);
                        setLinkedEmail(null);
                      }}
                      activeOpacity={0.7}
                    >
                      <Icon family="mci" name="pencil-outline" size={14} color={colors.primary} />
                      <Text style={styles.changeNumberText}>Use a different mobile number</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            ) : (
              <View style={styles.emailContainer}>
                <Text style={styles.emailLabel}>Email Address</Text>
                <View style={styles.emailInputWrap}>
                  <Icon family="mci" name="email-outline" size={18} color={colors.textSecondary} />
                  <TextInput
                    style={styles.emailInput}
                    placeholder="Enter your email address"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    value={email}
                    onChangeText={setEmail}
                  />
                </View>
                <Text style={styles.emailHint}>
                  We’ll send a 6-digit code to this address.
                </Text>
              </View>
            )}

            {/* 18+ Age verification */}
            <AgeVerificationCheckbox
              checked={ageVerified}
              onToggle={() => setAgeVerified((v) => !v)}
            />

            {/* Submit Button (Only shown when not selecting an option) */}
            {(!showOptions || loginMethod === 'email') && (
              <OTPButton
                onPress={loginMethod === 'phone' ? checkExistingUserAndSend : handleSendOTP}
                disabled={!isValid}
                loading={loading}
                title={loginMethod === 'phone' ? 'Find Account & Send OTP' : 'Send OTP to Email'}
                disabledTitle={loginMethod === 'phone' ? 'Enter 10-digit number first' : 'Enter your email first'}
              />
            )}


            {/* Google / Apple */}
            <SocialAuthButtons
              onGooglePress={handleGoogleSignIn}
              onApplePress={handleAppleSignIn}
            />

            {/* Terms + create account */}
            <TermsFooter
              onTermsPress={() => navigation.navigate('Terms')}
              onPrivacyPress={() => navigation.navigate('Privacy')}
              onCreateAccountPress={() => navigation.navigate('Register')}
            />
          </View>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
};





const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.primary,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  card: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    marginTop: -20,
    flexGrow: 1,
    paddingHorizontal: 22,
    paddingTop: 28,
    paddingBottom: 40,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#F3E5F5',
    borderRadius: 14,
    padding: 4,
    marginBottom: 24,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
  },
  tabButtonActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  tabTextActive: {
    color: colors.primary,
    fontWeight: '800',
  },
  tabContentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIcon: {
    width: 18,
    height: 18,
    marginRight: 6,
    resizeMode: 'contain',
  },
  emailContainer: {
    marginBottom: 16,
  },
  emailLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 8,
  },
  emailInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8F9FA',
    borderWidth: 1.5,
    borderColor: '#EDE7F6',
    borderRadius: 14,
    paddingHorizontal: 16,
    height: 56,
  },
  emailIcon: {
    fontSize: 18,
    marginRight: 10,
    color: colors.textSecondary,
  },
  emailInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginLeft: 10,
  },
  emailHint: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 6,
    marginLeft: 2,
  },
  // ── Dual Options Card Styles ──────────────────────────────────────────
  optionsContainer: {
    backgroundColor: '#F7F3FC',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1.5,
    borderColor: '#E8DCF7',
  },
  optionsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  checkBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionsTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text,
  },
  optionsSubtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  optionEmailButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1.5,
    borderColor: colors.primary,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  optionIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F3E8FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  optionEmailTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.primaryDark,
  },
  optionEmailHint: {
    fontSize: 11,
    fontWeight: '600',
    color: '#059669',
    marginTop: 2,
  },
  optionSmsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  optionSmsIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  optionSmsTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  optionSmsHint: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
  },
  changeNumberButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  changeNumberText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primary,
    marginLeft: 6,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-end',
  },
  modalDismissArea: {
    flex: 1,
  },
  googleSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 24,
    paddingTop: 22,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
  },
  googleHeader: {
    alignItems: 'center',
    marginBottom: 20,
  },
  googleLogoText: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  googleTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#202124',
    marginBottom: 2,
  },
  googleSubtitle: {
    fontSize: 13,
    color: '#5F6368',
  },
  accountsList: {
    marginBottom: 16,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F3F4',
  },
  avatarCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  avatarText: {
    fontSize: 16,
    fontWeight: '700',
  },
  accountDetails: {
    flex: 1,
  },
  accountName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#3C4043',
    marginBottom: 1,
  },
  accountEmail: {
    fontSize: 12,
    color: '#5F6368',
  },
  useAnotherButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
  },
  useAnotherText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#3C4043',
  },
  googleDisclaimer: {
    fontSize: 11,
    color: '#5F6368',
    lineHeight: 16,
    textAlign: 'left',
  },
});

export default LoginScreen;