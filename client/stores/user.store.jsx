/**
 * quasar
 *
 * Copyright (c) 2015 Glipcode http://glipcode.com
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
 * and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions
 * of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

let NotificationActions;
let RoomActions;
let RTCActions;

Dependency.autorun(()=> {
  NotificationActions = Dependency.get('NotificationActions');
  RoomActions = Dependency.get('RoomActions');
  RTCActions = Dependency.get('RTCActions');
});

// UserStore Creator
var UserStore = function() {
  let _this = this;
  let currentId = null;
  let cleared = false;

  // UserStore Reactive Vars
  _this.contacts = new ReactiveVar(null);
  _this.contactsError = new ReactiveVar(null);
  _this.user = Meteor.user;
  _this.userId = Meteor.userId;
  _this.loggingIn = Meteor.loggingIn;
  _this.loginError = new ReactiveVar(null);
  _this.logoutError = new ReactiveVar(null);
  _this.subscribed = new ReactiveVar(false);

  Meteor.subscribe('user', {
    onReady() {
      _this.subscribed.set(true);
    }
  });

  Meteor.subscribe('images');

  Tracker.autorun((c)=> {
    if (Meteor.loggingIn() ||
      (Meteor.userId() && !_this.subscribed.get())) {
      return;
    }

    if (!Meteor.userId() || (!!currentId && currentId !== Meteor.userId())) {
      _this.contacts.set(null); // clear contacts
      NotificationActions.clearListener(currentId); // clear user notifications
      RTCActions.disconnect(currentId); // disconnect from any conversations
    }

    if (Meteor.userId() &&
      (!currentId || currentId !== Meteor.userId())) {
      currentId = Meteor.userId();
      NotificationActions.registerListener(Meteor.userId());  // register notifications for the logged in user
      _this.getContacts();  // get the user's contacts
    }
  });

  // Callbacks
  _this.on = {

    loginFailed(error) {
      _this.loginError.set(error);
    },

    loginSuccess(user) {
      _this.loginError.set('');
    },

    loginStart() {
      _this.loginError.set('');
    },

    logoutFailed(error) {
      _this.logoutError.set(error);
    },

    logoutStart() {
      _this.logoutError.set('');
    },

    logoutSuccess() {
      _this.logoutError.set('');
    },
  };

  // If user is not logged in, login as guest
  _this.requireUser = ()=> {
    return new Promise((resolve, reject)=> {
      if (Meteor.user() && _this.subscribed.get()) {
        resolve(Meteor.user());
      } else if (Meteor.loggingIn() || !_this.subscribed.get()) {

        // wait for loggingIn
        Tracker.autorun((c)=> {
          if (Meteor.loggingIn() ||
            (Meteor.user() && !_this.subscribed.get())) {
            return;
          }

          // stop the tracker
          c.stop();

          if (Meteor.user()) {
            resolve(Meteor.user());
          } else {
            Meteor.loginVisitor(null, (err)=> {
              if (err) {
                reject(err);
              } else {
                resolve(Meteor.user());
              }
            });
          };
        });

      } else {
        Meteor.loginVisitor(null, (err)=> {
          if (err) {
            reject(err);
          } else {
            resolve(Meteor.user());
          }
        });
      }
    });
  };

  // is the user a guest user
  _this.isGuest = ()=> {
    return _this.user() && (!_this.user().services ||
    !_this.user().services.google || (
      !!_this.user().username &&
      _this.user().username.indexOf('guest-#') !== -1)
    );
  };

  _this.getContacts = ()=> {
    if (GooglePeople.readyForUse) {
      // we need to wait for google to get their shit together before we can use the People API :/
      if (!_this.contacts.get() &&
        !_this.isGuest() && _this.user().services.google) {

        GooglePeople.getContacts().then(function(res) {
          let modified = _.map(res, (val)=> {
            // we're getting buggy returns from Google People for photos right now
            let photo = val.photos ? _.find(val.photos, (photo)=> {
              return photo.metadata.primary;
            }).url : undefined;
            if (!photo || !(photo.endsWith('.jpg') || photo.endsWith('.png') ||
            photo.endsWith('.jpeg'))) {
              photo = undefined;
            }

            return {
              name: val.names ? _.find(val.names, (name)=> {
                return name.metadata.primary;
              }).displayName : undefined,
              email: val.emailAddresses ? _.find(val.emailAddresses, (email)=> {
                return email.metadata.primary;
              }).value : undefined,
              src: photo
            };
          });
          _this.contacts.set(modified);
        }, function(err) {
          console.error(err);
          _this.contactsError.set(error);
        });
      }
    } else {  // default to the Contacts API
      if (!_this.contacts.get() &&
        !_this.isGuest() && _this.user().services.google) {
        // get Google Contacts - we get this fresh every time right now
        Meteor.call('getContacts', function(err, res) {
          if (err) {
            _this.contactsError.set('could not retrieve contacts');
          } else {

            // update the user doc with contacts
            Meteor.users.update(
              {_id: _this.userId()},
              {$set: {'services.google.contacts': contacts}}
            );

            let contacts = res;
            _this.contacts.set(contacts);
            _.each(contacts, (contact)=> {
              if (contact.photoUrl) {
                // call server to request photo from google or retrieve from storage
                Meteor.call('getContactPhoto', contact, (error, id)=> {
                  if (!error) {
                    let cursor = Images.find(id);
                    let images = cursor.fetch();
                    // update contact with the image url once image is loaded
                    if (!!images && images.length && images[0].url()) {
                      contact.src = images[0].url();
                      _this.contacts.set(contacts);
                    } else {
                      // hack to deal with CollectionFS bug
                      // github.com/CollectionFS/Meteor-CollectionFS/issues/323
                      let liveQuery = cursor.observe({
                        changed: function(newImage, oldImage) {
                          if (newImage.url() !== null) {
                            liveQuery.stop();
                            contact.src = newImage.url();
                            _this.contacts.set(contacts);
                          }
                        }
                      });
                    }
                  }
                });
              }
            });
          }
        });
      }
    }
  };

  _this.updateProfileName = (name)=> {
    Meteor.users.update({_id: Meteor.userId()}, {$set: {'profile.name': name}});
  };

  _this.tokenId = Dispatcher.register((payload)=> {
    switch (payload.actionType){
      case 'USER_GET_CONTACTS':
        _this.getContacts();
        break;

      case 'USER_LOGIN_PASSWORD':
        _this.on.loginStart();
        Meteor.loginWithPassword(payload.user, payload.password, (err)=> {
          if (!err) {
            _this.on.loginSuccess();
          } else {
            _this.on.loginFailed(err);
          }
        });
        break;

      case 'USER_LOGIN_FACEBOOK':
        _this.on.loginStart();
        Meteor.loginWithFacebook({
          requestPermissions: ['public_profile', 'email', 'user_friends'],
          loginStyle: (Browser.mobile || Browser.tablet) ? 'redirect' : 'popup',
        }, (err)=> {
          if (!err) {
            _this.on.loginSuccess();
          } else {
            _this.on.loginFailed(err);
          }
        });
        break;

      case 'USER_LOGIN_GOOGLE':
        _this.on.loginStart();
        Meteor.loginWithGoogle({
          requestPermissions: [
            'https://www.googleapis.com/auth/contacts.readonly',
            'https://www.googleapis.com/auth/userinfo.email'
          ],
          loginStyle: (Browser.mobile || Browser.tablet) ? 'redirect' : 'popup',
          requestOfflineToken: true,
          forceApprovalPrompt: true
        }, (err)=> {
          if (!err) {
            _this.on.loginSuccess();
          } else {
            _this.on.loginFailed(err);
          }
        });
        break;

      case 'USER_LOGOUT':
        _this.on.logoutStart();
        Meteor.logout((err)=> {
          if (!err) {
            _this.on.logoutSuccess();
          } else {
            _this.on.logoutFailed(err);
          }
        });
        break;

      case 'USER_UPDATE_PROFILE_NAME':
        _this.updateProfileName(payload.name);
        break;
    }
  });

  return _this;
};

// Create the instance
Dependency.add('UserStore', new UserStore());
