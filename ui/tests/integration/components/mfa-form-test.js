import { module, test, skip } from 'qunit';
import { setupRenderingTest } from 'ember-qunit';
import { render } from '@ember/test-helpers';
import { hbs } from 'ember-cli-htmlbars';
import { setupMirage } from 'ember-cli-mirage/test-support';
import { fillIn, click, waitUntil } from '@ember/test-helpers';
import { run, later } from '@ember/runloop';

module('Integration | Component | mfa-form', function (hooks) {
  setupRenderingTest(hooks);
  setupMirage(hooks);

  hooks.beforeEach(function () {
    this.clusterId = '123456';
    this.mfaAuthData = {
      backend: 'userpass',
      data: { username: 'foo', password: 'bar' },
    };
    this.authService = this.owner.lookup('service:auth');
  });

  test('it should render correct descriptions', async function (assert) {
    const totpConstraint = this.server.create('mfa-method', { type: 'totp' });
    const oktaConstraint = this.server.create('mfa-method', { type: 'okta' });
    const duoConstraint = this.server.create('mfa-method', { type: 'duo' });

    this.mfaAuthData.mfa_requirement = this.authService._parseMfaResponse({
      mfa_request_id: 'test-mfa-id',
      mfa_constraints: { test_mfa_1: { any: [totpConstraint] } },
    }).mfa_requirement;

    await render(hbs`<MfaForm @clusterId={{this.clusterId}} @authData={{this.mfaAuthData}} />`);
    assert
      .dom('[data-test-mfa-description]')
      .includesText(
        'Enter your authentication code to log in.',
        'Correct description renders for single passcode'
      );

    this.mfaAuthData.mfa_requirement = this.authService._parseMfaResponse({
      mfa_request_id: 'test-mfa-id',
      mfa_constraints: { test_mfa_1: { any: [duoConstraint, oktaConstraint] } },
    }).mfa_requirement;

    await render(hbs`<MfaForm @clusterId={{this.clusterId}} @authData={{this.mfaAuthData}} />`);
    assert
      .dom('[data-test-mfa-description]')
      .includesText(
        'Select the MFA method you wish to use.',
        'Correct description renders for multiple methods'
      );

    this.mfaAuthData.mfa_requirement = this.authService._parseMfaResponse({
      mfa_request_id: 'test-mfa-id',
      mfa_constraints: { test_mfa_1: { any: [oktaConstraint] }, test_mfa_2: { any: [duoConstraint] } },
    }).mfa_requirement;

    await render(hbs`<MfaForm @clusterId={{this.clusterId}} @authData={{this.mfaAuthData}} />`);
    assert
      .dom('[data-test-mfa-description]')
      .includesText(
        'Two methods are required for successful authentication.',
        'Correct description renders for multiple constraints'
      );
  });

  test('it should render method selects and passcode inputs', async function (assert) {
    const duoConstraint = this.server.create('mfa-method', { type: 'duo', uses_passcode: true });
    const oktaConstraint = this.server.create('mfa-method', { type: 'okta' });
    const pingidConstraint = this.server.create('mfa-method', { type: 'pingid' });
    const { mfa_requirement } = this.authService._parseMfaResponse({
      mfa_request_id: 'test-mfa-id',
      mfa_constraints: {
        test_mfa_1: {
          any: [pingidConstraint, oktaConstraint],
        },
        test_mfa_2: {
          any: [duoConstraint],
        },
      },
    });
    this.mfaAuthData.mfa_requirement = mfa_requirement;

    this.server.post('/sys/mfa/validate', (schema, req) => {
      const json = JSON.parse(req.requestBody);
      const payload = {
        mfa_request_id: 'test-mfa-id',
        mfa_payload: { [oktaConstraint.id]: [], [duoConstraint.id]: ['test-code'] },
      };
      assert.deepEqual(json, payload, 'Correct mfa payload passed to validate endpoint');
      return {};
    });

    this.owner.lookup('service:auth').reopen({
      // override to avoid authSuccess method since it expects an auth payload
      async totpValidate({ mfa_requirement }) {
        await this.clusterAdapter().mfaValidate(mfa_requirement);
        return 'test response';
      },
    });

    this.onSuccess = (resp) =>
      assert.equal(resp, 'test response', 'Response is returned in onSuccess callback');

    await render(hbs`
      <MfaForm
        @clusterId={{this.clusterId}}
        @authData={{this.mfaAuthData}}
        @onSuccess={{this.onSuccess}}
      />
    `);
    await fillIn('[data-test-mfa-select="0"] select', oktaConstraint.id);
    await fillIn('[data-test-mfa-passcode="1"]', 'test-code');
    await click('[data-test-mfa-validate]');
  });

  test('it should validate mfa requirement', async function (assert) {
    const totpConstraint = this.server.create('mfa-method', { type: 'totp' });
    const { mfa_requirement } = this.authService._parseMfaResponse({
      mfa_request_id: 'test-mfa-id',
      mfa_constraints: {
        test_mfa: {
          any: [totpConstraint],
        },
      },
    });
    this.mfaAuthData.mfa_requirement = mfa_requirement;

    this.server.post('/sys/mfa/validate', (schema, req) => {
      const json = JSON.parse(req.requestBody);
      const payload = {
        mfa_request_id: 'test-mfa-id',
        mfa_payload: { [totpConstraint.id]: ['test-code'] },
      };
      assert.deepEqual(json, payload, 'Correct mfa payload passed to validate endpoint');
      return {};
    });

    const expectedAuthData = { clusterId: this.clusterId, ...this.mfaAuthData };
    this.owner.lookup('service:auth').reopen({
      // override to avoid authSuccess method since it expects an auth payload
      async totpValidate(authData) {
        await waitUntil(() =>
          assert.dom('[data-test-mfa-validate]').hasClass('is-loading', 'Loading class applied to button')
        );
        assert.dom('[data-test-mfa-validate]').isDisabled('Button is disabled while loading');
        assert.deepEqual(authData, expectedAuthData, 'Mfa auth data passed to validate method');
        await this.clusterAdapter().mfaValidate(authData.mfa_requirement);
        return 'test response';
      },
    });

    this.onSuccess = (resp) =>
      assert.equal(resp, 'test response', 'Response is returned in onSuccess callback');

    await render(hbs`
      <MfaForm
        @clusterId={{this.clusterId}}
        @authData={{this.mfaAuthData}}
        @onSuccess={{this.onSuccess}}
      />
    `);
    await fillIn('[data-test-mfa-passcode]', 'test-code');
    await click('[data-test-mfa-validate]');
  });

  // commented out in component until specific error code can be parsed from the api response
  skip('it should show countdown on passcode validation failure', async function (assert) {
    this.owner.lookup('service:auth').reopen({
      totpValidate() {
        throw new Error('Incorrect passcode');
      },
    });
    await render(hbs`
      <MfaForm
        @clusterId={{this.clusterId}}
        @authData={{this.mfaAuthData}}
      />
    `);

    await fillIn('[data-test-mfa-passcode]', 'test-code');
    later(() => run.cancelTimers(), 50);
    await click('[data-test-mfa-validate]');
    assert.dom('[data-test-mfa-validate]').isDisabled('Button is disabled during countdown');
    assert.dom('[data-test-mfa-passcode]').isDisabled('Input is disabled during countdown');
    assert.dom('[data-test-mfa-passcode]').hasNoValue('Input value is cleared on error');
    assert.dom('[data-test-inline-error-message]').exists('Alert message renders');
    assert.dom('[data-test-mfa-countdown]').exists('30 second countdown renders');
  });
});