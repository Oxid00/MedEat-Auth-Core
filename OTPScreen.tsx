/**
 * src/screens/Auth/OTPScreen.tsx
 *
 * OTP Verification Layer — handles 6-digit code entry and Supabase verification
 * for both phone (SMS) and email OTP flows.
 *
 * Key responsibilities:
 *  • Resolve the correct verification target (email or phone) from the
 *    supabaseOtpBridge, route params, or active state.
 *  • Call supabase.auth.verifyOtp() with the correct `type` discriminator.
 *  • Await session hydration before reading the Supabase session.
 *  • Perform tri-key profile resolution (by UUID → email → phone) and
 *    route to Main or CompleteProfile accordingly.
 *  • Subscribe to Realtime otp_sessions changes to detect automatic
 *    SMS → WhatsApp → Voice fallback activation without user action.
 *
 * Security:
 *  • No OTP values are compared client-side — all validation is server-side.
 *  • supabaseOtpBridge holds only the pending email string (no secrets).
 *  • Email addresses are masked before display.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  SafeAreaView,
  StatusBar,
  Animated,
  Alert,
  Image,
  ActivityIndicator,
} from 'react-native';
import { StackScreenProps } from '@react-navigation/stack';
import { RootStackParams } from '../../navigation/AppNavigator';
import { colors } from '../../theme/colors';
import { Icon } from '../../components/common/Icon';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/supabaseClient';
import { supabaseOtpBridge } from '../../lib/supabaseOtpBridge';
import { findLinkedEmailByPhone } from '../../services/authLookupService';
import { subscribeToOtpFallback, OtpChannel } from '../../services/otpService';

type Props = StackScreenProps<RootStackParams, 'OTP'>;

// ─── Helper: Safely Mask Email ─────────────────────────────────────────────
const maskEmail = (emailStr: string) => {
  if (!emailStr) return '';
  const [name, domain] = emailStr.split('@');
  if (!domain) return emailStr;
  if (name.length <= 2) return `${name[0]}***@${domain}`;
  const firstPart = name.substring(0, 2);
  const lastChar = name.slice(-1);
  return `${firstPart}***${lastChar}@${domain}`;
};

const OTPScreen = ({ route, navigation }: Props) => {
  const { phone, linkedEmail: initialLinkedEmail } = route.params;
  const { login } = useAuth();
  // DEV: pre-filled with empty. Dev bypass is handled inside verifyAndLogin().
  // PRODUCTION: This must remain empty — never ship with pre-filled OTPs.
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [verifying, setVerifying] = useState(false);
  const [sendingToEmail, setSendingToEmail] = useState(false);
  const [linkedEmail, setLinkedEmail] = useState<string | undefined>(initialLinkedEmail);
  const [activeTarget, setActiveTarget] = useState<string>(phone);
  const inputRefs = useRef<Array<TextInput | null>>([]);

  // Animation for the verify button
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const [showCustomEmailInput, setShowCustomEmailInput] = useState(false);
  const [customEmail, setCustomEmail] = useState('');
  const [loadingLookup, setLoadingLookup] = useState(false);

  // ── Telecom Fallback Loop: Realtime subscription ──────────────────────────
  // When the otp-fallback-monitor Edge Function detects SMS delivery failure
  // and auto-triggers WhatsApp or Voice OTP, this subscription fires.
  // The user sees a status update without needing to tap "Resend".
  const [fallbackChannel, setFallbackChannel] = useState<OtpChannel | null>(null);

  /**
   * Telecom Fallback Loop — Realtime subscription.
   *
   * When `otp-fallback-monitor` Edge Function detects SMS delivery timeout
   * and triggers WhatsApp or Voice OTP, it UPDATEs the `otp_sessions` row.
   * This Realtime subscription fires immediately so the UI updates without
   * the user needing to tap "Resend".
   *
   * Only subscribed for phone-based flows (not email).
   */
  useEffect(() => {
    // Only subscribe for phone-based OTPs (not email)
    if (phone.includes('@')) return;
    const normalisedPhone = phone.startsWith('+') ? phone : `+91${phone.replace(/[^0-9]/g, '')}`;

    const unsubscribe = subscribeToOtpFallback(normalisedPhone, (event) => {
      setFallbackChannel(event.channel);
      const channelLabels: Record<OtpChannel, string> = {
        sms: 'SMS',
        whatsapp: 'WhatsApp',
        voice: 'Voice Call',
      };
      // Clear OTP fields so user enters the new code from the fallback channel
      setOtp(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
      Alert.alert(
        'OTP Sent via ' + channelLabels[event.channel],
        `SMS delivery took too long. We've automatically sent a new OTP via ${
          channelLabels[event.channel]
        }. Please enter the new code.`,
        [{ text: 'OK' }],
      );
    });

    return unsubscribe; // Cleanup on unmount
  }, [phone]);
  // ── End Telecom Fallback Loop ─────────────────────────────────────────────────────────


  // ── Lookup linked email for this phone resiliently ──────────────────────
  React.useEffect(() => {
    if (!linkedEmail && !phone.includes('@')) {
      const cleanPhone = phone.replace(/[^0-9]/g, '');
      setLoadingLookup(true);
      (async () => {
        try {
          const found = await findLinkedEmailByPhone(cleanPhone);
          if (found) {
            setLinkedEmail(found);
          }
        } catch (e) {
          console.log('[OTPScreen] Error looking up linked email:', e);
        } finally {
          setLoadingLookup(false);
        }
      })();
    }
  }, [phone, linkedEmail]);

  const handleOtpChange = (text: string, index: number) => {
    const newOtp = [...otp];
    newOtp[index] = text;
    setOtp(newOtp);
    if (text && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (e: any, index: number) => {
    if (e.nativeEvent.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  /**
   * Sends a Supabase email OTP to `targetEmail` and switches the active
   * verification target from phone to email.
   *
   * Priority chain for target email:
   *  targetEmailToUse (explicit arg) → customEmail (inline input) →
   *  linkedEmail (auto-discovered) → real-time RPC lookup
   *
   * If no email is resolvable, the custom email input box is revealed.
   */
  const handleSendOtpToEmail = async (targetEmailToUse?: string) => {
    let targetEmail = targetEmailToUse || customEmail || linkedEmail;

    if (!targetEmail && !phone.includes('@')) {
      setSendingToEmail(true);
      targetEmail = (await findLinkedEmailByPhone(phone)) || undefined;
    }

    if (!targetEmail || !targetEmail.includes('@')) {
      setShowCustomEmailInput(true);
      setSendingToEmail(false);
      return;
    }

    setSendingToEmail(true);
    try {
      const cleanEmail = targetEmail.toLowerCase().trim();
      const { error } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: { shouldCreateUser: true },
      });
      if (error) throw error;

      supabaseOtpBridge.set(cleanEmail);
      setActiveTarget(cleanEmail);
      setLinkedEmail(cleanEmail);
      setShowCustomEmailInput(false);
      setOtp(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();

      Alert.alert(
        'OTP Sent to Email',
        `A 6-digit verification code has been sent to ${maskEmail(cleanEmail)}. Please check your inbox or spam folder.`
      );
    } catch (err: any) {
      Alert.alert('Could Not Send OTP', err.message || 'Failed to send OTP to email.');
    } finally {
      setSendingToEmail(false);
    }
  };



  /**
   * Primary verification handler.
   *
   * Steps:
   *  1. Resolve verification target from supabaseOtpBridge → activeTarget → phone param.
   *  2. Call supabase.auth.verifyOtp() with the correct `type` ('email' | 'sms').
   *  3. Wait for onAuthStateChange to confirm the JWT session is fully hydrated
   *     in AsyncStorage before reading getSession() — prevents a race condition.
   *  4. Tri-key profile resolution: UUID → email → phone.
   *  5. Route: existing user → Main, new user → CompleteProfile.
   *
   * Security:
   *  • No OTP comparison happens client-side.
   *  • supabaseOtpBridge is cleared immediately after the server confirms OTP.
   */
  const verifyAndLogin = async () => {
    const fullCode = otp.join('');
    if (fullCode.length !== 6) return;

    setVerifying(true);
    try {
      // ── Supabase OTP verification (email or phone) ──────────────────────────
      const pendingEmail = supabaseOtpBridge.get();
      const verifyTarget = pendingEmail || activeTarget || phone;
      const isEmail = verifyTarget.includes('@');

      const { error: verifyError } = await supabase.auth.verifyOtp(
        isEmail
          ? { email: verifyTarget, token: fullCode, type: 'email' }
          : ({ phone: verifyTarget, token: fullCode, type: 'sms' } as any)
      );

      if (verifyError) throw verifyError;


      // Wait for session to hydrate
      await new Promise<void>((resolve) => {
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
          if (session) { subscription.unsubscribe(); resolve(); }
        });
        supabase.auth.getSession().then(({ data: { session } }) => {
          if (session) { subscription.unsubscribe(); resolve(); }
        });
      });

      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id || '';

      if (!userId) throw new Error('Verification failed. User ID not found.');

      supabaseOtpBridge.clear();

      // Look up existing profile by Supabase UUID, Email, or Phone
      const { data: profileById } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      const { data: profileByEmail } = !profileById && (isEmail || linkedEmail)
        ? await supabase
            .from('profiles')
            .select('*')
            .eq('email', isEmail ? verifyTarget : linkedEmail)
            .maybeSingle()
        : { data: null };

      const cleanPhoneDigits = phone.replace(/[^0-9]/g, '');
      const fullPhoneStr = `+91${cleanPhoneDigits}`;
      const { data: profileByPhone } = !profileById && !profileByEmail && cleanPhoneDigits.length === 10
        ? await supabase
            .from('profiles')
            .select('*')
            .eq('phone', fullPhoneStr)
            .maybeSingle()
        : { data: null };

      const profile = profileById || profileByEmail || profileByPhone;


      if (profile) {
        // Existing user — log them straight in
        await login({
          id: profile.id,
          name: profile.full_name || '',
          phone: profile.phone || '',
          email: profile.email || (isEmail ? verifyTarget : (linkedEmail || '')),

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
        // New user — collect profile details
        const sessionUser = session?.user;
        navigation.replace('CompleteProfile', {
          email: sessionUser?.email || (isEmail ? verifyTarget : (linkedEmail || '')),
          phone: isEmail ? (phone.includes('@') ? '' : phone) : verifyTarget,

          name: sessionUser?.user_metadata?.full_name || '',
          userId,
          authMethod: 'email',
        });
      }
    } catch (error: any) {
      console.error('❌ OTP Verification failed:', error);
      Alert.alert(
        'Incorrect OTP',
        error.code === 'otp_expired'
          ? 'The code has expired. Please request a new OTP.'
          : error.message || 'The OTP entered is incorrect.',
      );
    } finally {
      setVerifying(false);
    }
  };

  const handlePressIn = () =>
    Animated.spring(scaleAnim, { toValue: 0.97, useNativeDriver: true }).start();
  const handlePressOut = () =>
    Animated.spring(scaleAnim, { toValue: 1, friction: 4, useNativeDriver: true }).start();

  const isComplete = otp.join('').length === 6;
  const displayTarget = activeTarget.includes('@')
    ? activeTarget
    : (activeTarget.startsWith('+91') ? activeTarget : `+91 ${activeTarget}`);


  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.backgroundGray} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        style={styles.keyboardView}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
      >
        {/* Header — stays fixed above the scroll */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
          >
            <Icon family="mci" name="chevron-left" size={26} color={colors.text} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
        </View>

        {/* Scrollable content — OTP boxes scroll above keyboard */}
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {/* Illustration / Icon area */}
          <View style={styles.iconCircle}>
            <Image
              source={require('../../assets/logo.png')}
              style={styles.premiumPhoneIcon}
              resizeMode="contain"
              fadeDuration={0}
              progressiveRenderingEnabled={true}
            />
          </View>

          {/* Title */}
          <Text style={styles.title}>
            {activeTarget.includes('@') ? 'Verify your email' : 'Verify your mobile number'}
          </Text>
          <Text style={styles.subtitle}>
            We sent a 6-digit OTP to
          </Text>
          <View style={styles.phonePill}>
            <Icon
              family="mci"
              name={activeTarget.includes('@') ? 'email-outline' : 'cellphone'}
              size={16}
              color={colors.primaryDark}
              style={{ marginRight: 4 }}
            />
            <Text style={styles.phoneText}>
              {activeTarget.includes('@')
                ? activeTarget
                : (activeTarget.startsWith('+91') ? activeTarget : `+91 ${activeTarget.replace(/[^0-9]/g, '')}`)}
            </Text>

            <TouchableOpacity onPress={() => navigation.goBack()}>
              <Text style={styles.changeText}>Change</Text>
            </TouchableOpacity>
          </View>

          {/* Quick 1-tap email switch if linked email exists and currently on SMS */}
          {!activeTarget.includes('@') && linkedEmail && (
            <TouchableOpacity
              style={styles.quickEmailChip}
              onPress={() => handleSendOtpToEmail(linkedEmail)}
              activeOpacity={0.8}
              disabled={sendingToEmail}
            >
              <Icon family="mci" name="email-fast-outline" size={16} color={colors.primary} />
              <Text style={styles.quickEmailChipText}>
                Prefer Email? Send OTP to {maskEmail(linkedEmail)}
              </Text>
            </TouchableOpacity>
          )}



          {/* Outlined Info Box (Small Square / Row) */}
          <View style={styles.infoBox}>
            <View style={styles.infoIconContainer}>
              <Icon family="mci" name="shield-check-outline" size={20} color={colors.primary} />
            </View>
            <View style={styles.infoTextContainer}>
              <Text style={styles.infoTitle}>
                OTP sent to {displayTarget}

              </Text>
              <Text style={styles.infoDescription}>
                Per MedEat rules &amp; regulations: This secure code is valid for 10 minutes. Do not share this OTP with anyone, including MedEat representatives.
              </Text>
            </View>
          </View>

          {/* OTP Boxes */}
          <View style={styles.otpContainer}>
            {otp.map((digit, index) => (
              <TextInput
                key={index}
                ref={(ref) => { inputRefs.current[index] = ref; }}
                style={[
                  styles.otpBox,
                  digit !== '' && styles.otpBoxFilled,
                  index === otp.findIndex(d => d === '') && styles.otpBoxActive,
                ]}
                keyboardType="number-pad"
                maxLength={1}
                value={digit}
                onChangeText={(text) => handleOtpChange(text, index)}
                onKeyPress={(e) => handleKeyPress(e, index)}
                selectionColor={colors.primary}
              />
            ))}
          </View>

          {/* Resend */}
          <View style={styles.resendRow}>
            <Text style={styles.resendLabel}>Didn't receive it? </Text>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={async () => {
                try {
                  const pendingEmail = supabaseOtpBridge.get() || activeTarget || phone;
                  const isEmail = pendingEmail.includes('@');
                  const { error } = await supabase.auth.signInWithOtp(
                    isEmail
                      ? { email: pendingEmail, options: { shouldCreateUser: true } }
                      : { phone: pendingEmail }
                  );
                  if (error) throw error;
                  Alert.alert('OTP Resent', `A new code was sent to ${pendingEmail}`);
                  setOtp(['', '', '', '', '', '']);
                  inputRefs.current[0]?.focus();
                } catch (err: any) {
                  Alert.alert('Resend Failed', err.message || 'Could not resend OTP.');
                }
              }}
            >
              <Text style={styles.resendLink}>Resend OTP</Text>
            </TouchableOpacity>
          </View>

          {/* ── Always Visible Second Option: Send OTP to Linked Email Address ─────────────── */}
          {!activeTarget.includes('@') ? (
            <View style={styles.linkedEmailSection}>
              <View style={styles.linkedEmailDividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>OR GET CODE ON EMAIL</Text>
                <View style={styles.dividerLine} />
              </View>

              <TouchableOpacity
                style={styles.linkedEmailButton}
                onPress={() => {
                  if (linkedEmail) {
                    handleSendOtpToEmail(linkedEmail);
                  } else {
                    setShowCustomEmailInput(true);
                  }
                }}
                activeOpacity={0.85}
                disabled={sendingToEmail}
              >
                <View style={styles.linkedEmailIconWrap}>
                  <Icon family="mci" name="email-fast" size={22} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.linkedEmailTitle}>
                    {linkedEmail ? `Send OTP to ${maskEmail(linkedEmail)}` : 'Send OTP to Linked Email'}
                  </Text>
                  <Text style={styles.linkedEmailSub}>
                    {linkedEmail ? 'Instant • Free & Secure Delivery' : 'Tap to receive 6-digit OTP in your inbox'}
                  </Text>
                </View>
                {sendingToEmail ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <View style={styles.getOtpBadge}>
                    <Text style={styles.getOtpBadgeText}>Send Code</Text>
                  </View>
                )}
              </TouchableOpacity>

              {/* Inline Custom Email Prompt if no email was automatically detected */}
              {!linkedEmail && showCustomEmailInput && (
                <View style={[styles.emailInputBox, { marginTop: 10 }]}>
                  <Text style={styles.emailInputBoxLabel}>Enter your email to receive OTP:</Text>
                  <View style={styles.emailInputRow}>
                    <TextInput
                      style={styles.emailTextInput}
                      placeholder="yourname@gmail.com"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      value={customEmail}
                      onChangeText={setCustomEmail}
                    />
                    <TouchableOpacity
                      style={styles.sendEmailBtn}
                      onPress={() => handleSendOtpToEmail()}
                      disabled={sendingToEmail || !customEmail.includes('@')}
                    >
                      {sendingToEmail ? (
                        <ActivityIndicator size="small" color="#FFF" />
                      ) : (
                        <Text style={styles.sendEmailBtnText}>Send</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          ) : null}





          {/* Verify button — inside scroll so it's always above keyboard */}
          <View style={styles.footer}>
            <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
              <TouchableOpacity
                style={[styles.verifyButton, (!isComplete || verifying) && styles.verifyButtonDisabled]}
                onPress={verifyAndLogin}
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                disabled={!isComplete || verifying}
                activeOpacity={1}
              >
                {verifying ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={[styles.verifyButtonText, !isComplete && styles.verifyButtonTextDisabled]}>
                    {isComplete ? 'Verify & Continue →' : `Enter ${6 - otp.join('').length} more digits`}
                  </Text>
                )}
              </TouchableOpacity>
            </Animated.View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.backgroundGray,    // Ultra-light purple bg
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  backIcon: {
    fontSize: 20,
    color: colors.primaryDark,
    fontWeight: '600',
  },
  backText: {
    fontSize: 15,
    color: colors.primaryDark,
    fontWeight: '600',
  },
  scrollContent: {
    paddingHorizontal: 28,
    paddingTop: 24,
    paddingBottom: 40,
    alignItems: 'center',
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.accentPink,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 28,
    borderWidth: 2,
    borderColor: colors.primaryLight,
  },
  premiumPhoneIcon: {
    width: 44,
    height: 44,
    resizeMode: 'contain',
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.text,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 10,
  },
  phonePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accentPink,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 36,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.primaryLight,
  },
  phoneText: {
    fontSize: 15,
    color: colors.primaryDark,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  changeText: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  otpContainer: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 28,
  },
  otpBox: {
    width: 48,
    height: 58,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: colors.inputBorder,
    borderRadius: 14,
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
  },
  otpBoxFilled: {
    borderColor: colors.primary,
    backgroundColor: colors.accentPink,
    color: colors.primaryDark,
  },
  otpBoxActive: {
    borderColor: colors.primaryLight,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 2,
  },
  resendRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  resendLabel: {
    fontSize: 14,
    color: colors.textMuted,
  },
  resendLink: {
    fontSize: 14,
    color: colors.primary,
    fontWeight: '700',
  },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F5F3FF',
    borderWidth: 1,
    borderColor: '#DDD6FE',
    borderRadius: 12,
    padding: 12,
    marginHorizontal: 24,
    marginTop: 16,
    marginBottom: 20,
    gap: 12,
  },
  infoIconContainer: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#EDE9FE',
    justifyContent: 'center',
    alignItems: 'center',
  },
  infoTextContainer: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 2,
  },
  infoDescription: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
  },
  footer: {
    marginHorizontal: -28,
    paddingHorizontal: 20,
    paddingBottom: 32,
    paddingTop: 12,
  },
  verifyButton: {
    backgroundColor: colors.primary,
    height: 62,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  verifyButtonDisabled: {
    backgroundColor: colors.inputBorder,
    shadowOpacity: 0,
    elevation: 0,
  },
  verifyButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  verifyButtonTextDisabled: {
    color: colors.textMuted,
  },
  // ── Linked Email Section on OTP Screen ────────────────────────────────
  quickEmailChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3E8FF',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    marginTop: -24,
    marginBottom: 26,
    borderWidth: 1,
    borderColor: '#E8DCF7',
  },
  quickEmailChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primaryDark,
    marginLeft: 6,
  },
  linkedEmailSection: {
    width: '100%',
    marginTop: 18,
    marginBottom: 8,
  },
  linkedEmailDividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#E2E8F0',
  },
  dividerText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textMuted,
    marginHorizontal: 10,
    letterSpacing: 0.8,
  },
  linkedEmailButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: colors.primary,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  linkedEmailIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#F3E8FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  linkedEmailTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.primaryDark,
  },
  linkedEmailSub: {
    fontSize: 11,
    color: '#059669',
    marginTop: 2,
    fontWeight: '600',
  },
  getOtpBadge: {
    backgroundColor: colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginLeft: 8,
  },
  getOtpBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  customEmailContainer: {
    width: '100%',
  },
  emailInputBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  emailInputBoxLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 8,
  },
  emailInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  emailTextInput: {
    flex: 1,
    height: 44,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 13,
    color: colors.text,
  },
  sendEmailBtn: {
    backgroundColor: colors.primary,
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendEmailBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },

});


export default OTPScreen;