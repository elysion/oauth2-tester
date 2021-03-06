import {
  AccessTokenResponse,
  AccountGeneratorFn,
  AuthorizationCodeDetails,
  AuthorizationCodeRequestOptions,
  Client,
  ClientGeneratorFn,
  ConsentFn,
  LoginFn,
  OAuthProperties,
  RegisterAccountFn,
  RemoveAccountFn,
  RemoveClientFn,
  TestFunctions,
  UserAccount,
} from './types'
import OAuth2Tester from './OAuth2Tester'
import { TestHelpers } from './testHelpers'
import * as uuid from 'uuid'
import axios, { AxiosResponse } from 'axios'
import * as toughCookie from 'tough-cookie'
import axiosCookiejarSupport from 'axios-cookiejar-support'
import * as R from 'ramda'

axiosCookiejarSupport(axios)

export abstract class SharedAuthorizationCodeGrantTester extends OAuth2Tester {
  // Needed for authorization code and resource owner password grants
  protected registerAccount: RegisterAccountFn
  protected accountGenerator: AccountGeneratorFn

  // Needed for authorization code grant
  protected login: LoginFn
  protected consent: ConsentFn
  protected removeAccount: RemoveAccountFn
  protected cookieJars: { [x: string]: toughCookie.CookieJar } = {}

  constructor(
    oauthProperties: OAuthProperties,
    client: {
      clientGenerator: ClientGeneratorFn
      removeClient: RemoveClientFn
    },
    user: {
      registerAccount: RegisterAccountFn
      removeAccount: RemoveAccountFn
      login: LoginFn
      consent: ConsentFn
      accountGenerator: AccountGeneratorFn
    }
  ) {
    super(oauthProperties, client)
    this.registerAccount = user.registerAccount
    this.removeAccount = user.removeAccount
    this.login = user.login
    this.consent = user.consent
    this.accountGenerator = user.accountGenerator
  }

  registerSharedTests(testFunctions: TestFunctions) {
    const { describe, it, step, before, after, fail } = testFunctions
    const { expectErrorRedirectToIncludeQuery, expectRedirectToIncludeQuery, expectToFailWithStatus } = new TestHelpers(
      fail
    )

    const redirectUri = 'https://an-awesome-service.com/' // TODO: specify in suites

    describe('shared authorization code grant tests', () => {
      describe('when request details are valid', () => {
        const clientName = uuid.v4()
        let client
        const availableScopes = this.oauthProperties.availableScopes()

        before('Generate OAuth client', async () => {
          client = await this.clientGenerator(clientName, redirectUri, availableScopes)
        })

        after('Remove OAuth client', async () => {
          await this.removeClient(clientName)
        })

        const verifyScopes = (expected: string[], actual: string[]) => {
          if (R.without(expected, actual).length !== 0) {
            fail(expected, actual, `Returned scopes do not match requested. Actual: ${actual}, expected: ${expected}`)
          }
        }

        describe('when using all scopes', () => {
          let user: UserAccount
          let authorizationCodeDetails: AuthorizationCodeDetails
          let accessTokenResponse: AccessTokenResponse

          before('Generate user details', async () => {
            user = await this.accountGenerator()
          })

          before('Register user', async () => {
            await this.registerAccount(user)
            this.cookieJars[user.username] = new toughCookie.CookieJar()
          })

          after('Remove user', async () => {
            await this.removeAccount(user.username)
          })

          step('Fetch authorization code for all scopes', async () => {
            authorizationCodeDetails = await this.fetchAuthorizationCode(client, user, {
              scopes: availableScopes,
            })

            if (!authorizationCodeDetails.authorizationCode) {
              fail('Authorization code was not returned or was empty')
            }

            verifyScopes(authorizationCodeDetails.scopes, availableScopes)
          })

          step('Fetch access token', async () => {
            accessTokenResponse = await this.fetchAccessToken(client, authorizationCodeDetails)

            const accessTokenDetails = accessTokenResponse.accessTokenDetails
            if (!accessTokenDetails.accessToken) {
              fail('Access token was not returned or was empty')
            }

            verifyScopes(accessTokenDetails.scopes, availableScopes)
          })
        })

        describe('when using single scope', () => {
          for (const scope of this.oauthProperties.availableScopes()) {
            let authorizationCodeDetails: AuthorizationCodeDetails
            let accessTokenResponse: AccessTokenResponse

            describe(`with scope: ${scope}`, () => {
              let user

              before('Generate user details', async () => {
                user = await this.accountGenerator()
              })

              before('Register user', async () => {
                await this.registerAccount(user)
                this.cookieJars[user.username] = new toughCookie.CookieJar()
              })

              after('Remove user', async () => {
                await this.removeAccount(user.username)
              })

              step(`Fetch authorization code`, async () => {
                authorizationCodeDetails = await this.fetchAuthorizationCode(client, user, {
                  scopes: [scope],
                })

                if (!authorizationCodeDetails.authorizationCode) {
                  fail('Authorization code was not returned or was empty')
                }

                verifyScopes(authorizationCodeDetails.scopes, [scope])
              })

              step('Fetch access token', async () => {
                accessTokenResponse = await this.fetchAccessToken(client, authorizationCodeDetails)

                const accessTokenDetails = accessTokenResponse.accessTokenDetails
                if (!accessTokenDetails.accessToken) {
                  fail('Access token was not returned or was empty')
                }

                verifyScopes(accessTokenDetails.scopes, [scope])
              })
            })
          }
        })
      })

      describe('when reusing the authorization code', () => {
        const clientName = uuid.v4()
        let client: Client
        let user: UserAccount
        let authorizationCodeDetails: AuthorizationCodeDetails
        let accessTokenResponse: AccessTokenResponse

        before('Generate OAuth client', async () => {
          client = await this.clientGenerator(clientName, redirectUri, this.oauthProperties.availableScopes())
        })

        before('Register user', async () => {
          user = await this.accountGenerator()
          await this.registerAccount(user)
          this.cookieJars[user.username] = new toughCookie.CookieJar()
        })

        before('Fetch authorization code', async () => {
          authorizationCodeDetails = await this.fetchAuthorizationCode(client, user, {
            scopes: this.oauthProperties.availableScopes(),
          })
        })

        before('Fetch access token', async () => {
          accessTokenResponse = await this.fetchAccessToken(client, authorizationCodeDetails)
        })

        after('Remove user', async () => {
          await this.removeAccount(user.username)
        })

        after('Remove OAuth client', async () => {
          await this.removeClient(clientName)
        })

        // TODO: revoke access codes granted for the authorization code
        it('fails if authorization code is reused', () => {
          // TODO: how should this work for PKCE where the authorization code and code verifier cannot be found from the db even if they are sent
          return expectErrorRedirectToIncludeQuery(redirectUri, { error: 'invalid_grant' }, () =>
            this.fetchAccessToken(client, authorizationCodeDetails)
          )
        })
      })

      describe('when request details are invalid', () => {
        const clientName = uuid.v4()
        let user: UserAccount
        let client: Client

        before('Generate OAuth client', async () => {
          client = await this.clientGenerator(clientName, redirectUri, this.oauthProperties.availableScopes())
        })

        after('Remove OAuth client', async () => {
          await this.removeClient(clientName)
        })

        before('Register user', async () => {
          user = await this.accountGenerator()
          await this.registerAccount(user)
          this.cookieJars[user.username] = new toughCookie.CookieJar()
        })

        after('Remove user', async () => {
          await this.removeAccount(user.username)
        })

        describe('when fetching authorization code', () => {
          it('fails if scope is invalid', async () => {
            await expectRedirectToIncludeQuery(redirectUri, { error: 'invalid_scope' }, () =>
              this.requestAuthorizationCode(client, user, {
                scopes: ['invalid-scope'],
              })
            )
          })
        })

        describe('when user credentials are invalid', () => {
          it('should fail', async () => {
            try {
              await this.requestAuthorizationCode(
                client,
                {
                  username: 'foo',
                  password: 'bar',
                },
                { scopes: this.oauthProperties.availableScopes() }
              )
              fail('Expected to fail with incorrect credentials')
              // tslint:disable-next-line:no-empty
            } catch (e) {}
          })
        })
      })

      describe('when fetching authorization code', () => {
        let user
        const clientName = uuid.v4()
        let client

        before('Generate OAuth client', async () => {
          client = await this.clientGenerator(clientName, redirectUri, this.oauthProperties.availableScopes())
        })

        // TODO: share this between classes to remove duplication
        const registerUserSetupAndTeardown = () => {
          before('Register user', async () => {
            user = await this.accountGenerator()
            await this.registerAccount(user)
            this.cookieJars[user.username] = new toughCookie.CookieJar()
          })

          after('Remove user', async () => {
            await this.removeAccount(user.username)
            delete this.cookieJars[user.username]
          })
        }

        describe('when redirect URI port is incorrect', () => {
          registerUserSetupAndTeardown()
          it('should fail', () => {
            return expectToFailWithStatus(400, () =>
              this.requestAuthorizationCode({ ...client, redirectUri: `${redirectUri}:5000` }, user, {
                scopes: this.oauthProperties.availableScopes(),
              })
            )
          })
        })

        describe('when redirect URI is incorrect', () => {
          registerUserSetupAndTeardown()
          it('should fail', () => {
            return expectToFailWithStatus(400, () =>
              this.requestAuthorizationCode({ ...client, redirectUri: 'http://some-incorrect-uri.com' }, user, {
                scopes: this.oauthProperties.availableScopes(),
              })
            )
          })
        })

        // TODO: why is this different from the one in PKCE test?
        describe('when user does not consent', () => {
          registerUserSetupAndTeardown()
          it('should fail', async () => {
            await expectRedirectToIncludeQuery(redirectUri, { error: 'access_denied' }, () =>
              this.requestAuthorizationCode(client, user, {
                shouldConsent: false,
                scopes: this.oauthProperties.availableScopes(),
              })
            )
          })
        })
      })
    })

    /* TODO: cases
     * Verify token type?
     * Incorrect token type request?
     * Different scopes for authorization code, access token and refresh token requests
     * New refresh token scope is identical to the revoked
     * State parameter (also on errors)
     * No redirect uri in authorization request
     * No scope in authorization code, access token and refresh token requests
     * Check expiresIn
     * Embedded browser / frame (possible to test? requires a web server?)
     * CSRF against redirect-uri?
     * DoS attack that exhaust resources
     * PKCE
     * * Access token response does not contain refresh token
     * Validate request_uri in access token request iff it was provided in the authorization token request (redirect_uri is optional in authorize)
     * Ensure endpoint query is retained
     * Endpoint uri MUST NOT include a fragment component (redirect)
     * Redirection uri must be an absolute URI
     * Redirect uri trailing slash after origin
     * Invalid redirect_uri in authorization request results in an invalid_request instead of unauthorized_client error
     * Assert 40x error body
     */
  }

  async requestAuthorizationCode(
    client: Client,
    user: UserAccount,
    options: AuthorizationCodeRequestOptions = {
      extraParams: {},
    }
  ): Promise<AxiosResponse> {
    options.shouldConsent = options.shouldConsent === undefined ? true : options.shouldConsent
    const jar = this.cookieJars[user.username]

    const res = await axios({
      jar,
      url: this.oauthProperties.authorizationEndpoint(),
      method: 'GET',
      withCredentials: true,
      params: {
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        scope: options.scopes ? options.scopes.join(' ') : undefined,
        response_type: 'code', // TODO: add state?
        ...options.extraParams,
      },
    })

    const loginResponse = await this.login(res, user, jar)
    const loginRedirectResponse = await this.followRedirect(loginResponse, jar)

    const location = loginRedirectResponse.headers.location
    const returnedRedirectQuery = location.substring(location.indexOf('?'))
    if (new URLSearchParams(returnedRedirectQuery).get('error')) {
      return loginRedirectResponse
    }

    const consentPageResponse = await this.followRedirect(loginRedirectResponse, jar)

    // TODO: assert scopes
    return await this.consent(options.shouldConsent, consentPageResponse, user, jar, options.scopes)
  }

  async followRedirect(res: AxiosResponse, jar: toughCookie.CookieJar): Promise<AxiosResponse> {
    const redirectUrl = new URL(res.headers.location, new URL(res.config.url).origin)
    return axios({
      jar,
      url: redirectUrl.toString(),
      method: 'GET',
      withCredentials: true,
      maxRedirects: 0,
      validateStatus: (status) => [200, 302].includes(status),
    })
  }

  extractAuthorizationCodeFromResponse(res: AxiosResponse): string {
    const returnedRedirectUrl = res.headers.location
    const authorizationCode = new URL(returnedRedirectUrl).searchParams.get('code')

    if (!authorizationCode) {
      throw new Error(`Authorization code not returned in redirect url: ${res.headers.location}`)
    }

    return authorizationCode
  }

  async fetchAuthorizationCode(
    client: Client,
    user: UserAccount,
    options: AuthorizationCodeRequestOptions = {
      shouldConsent: true,
      extraParams: {},
    }
  ): Promise<AuthorizationCodeDetails> {
    const res = await this.requestAuthorizationCode(client, user, options)
    const authorizationCode = this.extractAuthorizationCodeFromResponse(res)

    return {
      authorizationCode,
      scopes: options.scopes,
    }
  }

  abstract fetchAccessToken(
    client: Client,
    authorizationCodeDetails: AuthorizationCodeDetails
  ): Promise<AccessTokenResponse>

  async cleanup() {
    return
  }
}
