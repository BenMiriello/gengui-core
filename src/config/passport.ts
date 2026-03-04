import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { oauthService } from '../services/auth/oauth';
import type { OAuthProfile } from '../services/auth/oauth.types';
import { env } from './env';

if (
  env.GOOGLE_CLIENT_ID &&
  env.GOOGLE_CLIENT_SECRET &&
  env.GOOGLE_CALLBACK_URL
) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        callbackURL: env.GOOGLE_CALLBACK_URL,
        scope: ['profile', 'email'],
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          const emailVerified = profile.emails?.[0]?.verified ?? false;

          if (!email) {
            return done(new Error('NO_EMAIL_FROM_PROVIDER'));
          }

          const oauthProfile: OAuthProfile = {
            provider: 'google',
            providerId: profile.id,
            email,
            emailVerified,
            displayName: profile.displayName,
            avatarUrl: profile.photos?.[0]?.value,
          };

          const result = await oauthService.determineAction(oauthProfile);

          if (result.action === 'create') {
            const user = await oauthService.createOAuthUser(oauthProfile);
            return done(null, user);
          }

          if (result.action === 'login') {
            return done(null, result.user as any);
          }

          if (result.action === 'link') {
            await oauthService.linkOAuthToUser(result.user?.id, oauthProfile);
            return done(null, result.user as any);
          }

          if (result.action === 'confirm_password') {
            return done(null, false, {
              message: 'PASSWORD_CONFIRMATION_REQUIRED',
              pendingProfile: oauthProfile,
            });
          }

          return done(new Error('UNEXPECTED_ACTION'));
        } catch (error) {
          return done(error);
        }
      },
    ),
  );
}

export { passport };
